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

    const raw = res.data;
    // Nado may nest the response under "data" or return it directly
    // Try multiple unwrap levels to find the actual subaccount data
    const data = raw?.data?.data ?? raw?.data ?? raw;

    logger.info(`Nado: raw response keys: ${JSON.stringify(Object.keys(raw ?? {}))}`);
    if (raw?.data) {
      logger.info(`Nado: raw.data keys: ${JSON.stringify(Object.keys(raw.data))}`);
      if (raw.data.data) {
        logger.info(`Nado: raw.data.data keys: ${JSON.stringify(Object.keys(raw.data.data))}`);
      }
    }

    if (!data || (data.exists !== undefined && !data.exists)) {
      throw new Error("Nado: subaccount does not exist");
    }

    // Nado (Vertex fork) may return health as:
    // - data.health = { assets, liabilities, initial_health, maintenance_health }
    // - data.healths = [{ health_type: "initial", assets, liabilities }, ...]
    let assets = 0;
    let initialHealth = 0;
    let maintenanceHealth = 0;

    if (data.health) {
      logger.info(`Nado: health object: ${JSON.stringify(data.health)}`);
      assets = Number(data.health.assets) / X18;
      initialHealth = Number(data.health.initial_health) / X18;
      maintenanceHealth = Number(data.health.maintenance_health) / X18;
    } else if (Array.isArray(data.healths)) {
      logger.info(`Nado: healths array (${data.healths.length} items): ${JSON.stringify(data.healths)}`);
      for (const h of data.healths) {
        const hAssets = Number(h.assets ?? 0) / X18;
        const hLiabilities = Number(h.liabilities ?? 0) / X18;
        if (h.health_type === "initial") {
          assets = hAssets;
          initialHealth = hAssets - hLiabilities;
        } else if (h.health_type === "maintenance") {
          maintenanceHealth = hAssets - hLiabilities;
        }
      }
    } else {
      logger.warn("Nado: no health/healths found. Data keys: " + Object.keys(data).join(", "));
      // Dump first level of all data for debugging
      for (const key of Object.keys(data)) {
        const val = data[key];
        const preview = typeof val === "object" ? JSON.stringify(val).slice(0, 200) : String(val);
        logger.warn(`Nado:   data.${key} = ${preview}`);
      }
    }

    logger.info(`Nado: parsed assets=${assets}, initialHealth=${initialHealth}, maintenanceHealth=${maintenanceHealth}`);

    const spotBalances: SpotBalance[] = data.spot_balances ?? [];
    const perpBalances: PerpBalance[] = data.perp_balances ?? [];

    // Total equity = assets
    const totalUsd = assets;
    // Free collateral ~ initial_health (positive means available margin)
    const freeMargin = Math.max(initialHealth, 0);
    const marginUsed = totalUsd - freeMargin;

    const marginFreePercent =
      totalUsd > 0 ? (freeMargin / totalUsd) * 100 : 100;

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
