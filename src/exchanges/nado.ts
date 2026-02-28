import axios from "axios";
import { ExchangeBalance, ExchangeFetcher, Position } from "./types";
import { config } from "../config";
import { logger } from "../utils/logger";

// Nado API: https://docs.nado.xyz/developer-resources/api
// Gateway queries are read-only and do NOT require EIP-712 signing.
// All amounts are x18 (18 decimal places).
// Subaccount = 32-byte hex: address (20 bytes) + zero-padded subaccount name (12 bytes)

const X18 = 1e18;

function toSubaccount(address: string, name = "default"): string {
  // Subaccount = address (20 bytes) + name as bytes12 (UTF-8, zero-padded)
  // Nado UI and SDKs use "default" as the standard subaccount name.
  // "default" in hex = 64656661756c74 (7 bytes) + 5 zero bytes padding
  const addr = address.toLowerCase().replace("0x", "");
  const nameHex = Buffer.from(name).toString("hex").padEnd(24, "0");
  return "0x" + addr + nameHex;
}

interface SubaccountHealth {
  assets: string;
  liabilities: string;
  initial_health: string;
  maintenance_health: string;
}

interface SpotBalance {
  product_id: number;
  balance: { amount: string };
}

interface PerpBalance {
  product_id: number;
  balance: {
    amount: string;
    v_quote_balance: string;
    last_cumulative_funding_x18: string;
  };
}

export class NadoFetcher implements ExchangeFetcher {
  name = "Nado";
  enabled: boolean;

  constructor() {
    this.enabled = !!config.nado.walletAddress;
    if (!this.enabled) {
      logger.warn("Nado: wallet address not set — skipping");
    }
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    const base = config.nado.gatewayUrl;
    const subaccount = toSubaccount(config.nado.walletAddress!);

    // Gateway queries are read-only — no authentication needed
    const headers = {
      "Accept-Encoding": "gzip, br, deflate",
      Accept: "application/json",
    };

    // Fetch subaccount info (includes health + balances + perp positions)
    const res = await axios.get(`${base}/query`, {
      params: { type: "subaccount_info", subaccount },
      headers,
      timeout: 10000,
    });

    const data = res.data?.data ?? res.data;

    if (!data || !data.exists) {
      throw new Error("Nado: subaccount does not exist");
    }

    const health: SubaccountHealth = data.health;
    const spotBalances: SpotBalance[] = data.spot_balances ?? [];
    const perpBalances: PerpBalance[] = data.perp_balances ?? [];

    const assets = Number(health.assets) / X18;
    const liabilities = Number(health.liabilities) / X18;
    const initialHealth = Number(health.initial_health) / X18;
    const maintenanceHealth = Number(health.maintenance_health) / X18;

    // Total equity = assets (collateral + position values)
    const totalUsd = assets;
    // Free collateral ~ initial_health (positive means available margin)
    const balance = Math.max(initialHealth, 0);
    const marginUsed = assets - balance;

    // maintenance_health > 0 means safe
    // marginFreePercent = (maintenance_health / assets) * 100
    const marginFreePercent =
      assets > 0 ? (maintenanceHealth / assets) * 100 : 100;

    // USDC is product_id 0 typically
    const usdcBalance = spotBalances.find((b) => b.product_id === 0);
    const collateral = usdcBalance ? Number(usdcBalance.balance.amount) / X18 : 0;

    // Also fetch product info for market names
    let productsMap: Record<number, string> = {};
    try {
      const productsRes = await axios.get(`${base}/query`, {
        params: { type: "all_products" },
        headers,
        timeout: 10000,
      });
      const products = productsRes.data?.data ?? productsRes.data ?? [];
      if (Array.isArray(products)) {
        for (const p of products) {
          if (p.product_id !== undefined && p.symbol) {
            productsMap[p.product_id] = p.symbol;
          }
        }
      }
    } catch {
      // Non-critical, continue with product IDs
    }

    const positions: Position[] = perpBalances
      .filter((p) => Number(p.balance.amount) !== 0)
      .map((p) => {
        const size = Number(p.balance.amount) / X18;
        const vQuote = Number(p.balance.v_quote_balance) / X18;
        // Entry price approximation: -vQuote / size
        const entryPrice = size !== 0 ? Math.abs(vQuote / size) : 0;

        return {
          market: productsMap[p.product_id] ?? `product-${p.product_id}`,
          side: size >= 0 ? "long" as const : "short" as const,
          size: Math.abs(size),
          entryPrice,
          unrealizedPnl: 0, // Would need mark price to calculate
        };
      });

    return {
      exchange: this.name,
      timestamp: new Date().toISOString(),
      totalUsd,
      balance: collateral,
      marginUsed,
      marginFreePercent,
      positionCount: positions.length,
      unrealizedPnl: 0, // Need mark prices for accurate PnL
      positions,
      raw: data as unknown as Record<string, unknown>,
    };
  }
}
