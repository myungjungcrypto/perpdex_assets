import axios from "axios";
import { ExchangeBalance, ExchangeFetcher, Position } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Lighter REST API: https://apidocs.lighter.xyz
// Base URL: https://mainnet.zklighter.elliot.ai
// Auth: Not needed for GET /api/v1/account (public endpoint)
// RO token format: ro:{account_index}:{scope}:{expiry}:{hex}
//
// GET /api/v1/account?by=index&value={account_index}
// Response: { code: 0, accounts: [{ collateral, positions, ... }] }

interface LighterPosition {
  market_id: number;
  symbol: string;
  sign: number; // 1 = long, -1 = short
  position: string;
  avg_entry_price: string;
  position_value: string;
  unrealized_pnl: string;
  realized_pnl: string;
  liquidation_price: string;
  initial_margin_fraction: string;
  margin_mode: number;
  allocated_margin: string;
  open_order_count: number;
}

interface LighterAccount {
  index: number;
  collateral: string;
  available_balance: string;
  total_asset_value: string;
  positions: LighterPosition[];
}

interface LighterResponse {
  code: number;
  total: number;
  accounts: LighterAccount[];
}

export class LighterFetcher implements ExchangeFetcher {
  name = "Lighter";
  enabled: boolean;

  constructor() {
    this.enabled = !!config.lighter.roToken;
    if (!this.enabled) {
      logger.warn("Lighter: Read-Only token not set — skipping");
    }
  }

  private getAccountIndex(): string {
    // Extract account index from RO token: ro:{account_index}:{scope}:{expiry}:{hex}
    const parts = config.lighter.roToken!.split(":");
    if (parts.length >= 2 && parts[0] === "ro") {
      return parts[1];
    }
    // Fallback: try to use the whole token as account index
    return parts[1] ?? "0";
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    const base = config.lighter.baseUrl;
    const accountIndex = this.getAccountIndex();

    const accountRes = await axios.get<LighterResponse>(`${base}/api/v1/account`, {
      params: { by: "index", value: accountIndex },
      headers: { Accept: "application/json" },
      timeout: 10000,
    });

    const data = accountRes.data;
    const account = data.accounts?.[0];
    if (!account) {
      throw new Error(`Lighter: no account found for index ${accountIndex}`);
    }

    const collateral = Number(account.collateral ?? 0);
    const availableBalance = Number(account.available_balance ?? 0);
    const totalAssetValue = Number(account.total_asset_value ?? 0);
    const positionsRaw: LighterPosition[] = account.positions ?? [];

    // Filter out zero-size positions and calculate unrealized PnL
    let totalUnrealizedPnl = 0;
    const positions: Position[] = positionsRaw
      .filter((p) => Math.abs(Number(p.position)) > 0)
      .map((p) => {
        const pnl = Number(p.unrealized_pnl ?? 0);
        totalUnrealizedPnl += pnl;
        return {
          market: p.symbol ?? `market-${p.market_id}`,
          side: p.sign >= 0 ? "long" as const : "short" as const,
          size: Math.abs(Number(p.position)),
          entryPrice: Number(p.avg_entry_price),
          unrealizedPnl: pnl,
          liquidationPrice: Number(p.liquidation_price) || undefined,
          leverage: p.initial_margin_fraction
            ? 1 / Number(p.initial_margin_fraction)
            : undefined,
        };
      });

    // Use API-provided values directly instead of manual calculation
    const totalUsd = totalAssetValue > 0 ? totalAssetValue : collateral + totalUnrealizedPnl;
    const marginUsed = totalUsd - availableBalance;
    const marginFreePercent =
      totalUsd > 0 ? (availableBalance / totalUsd) * 100 : 100;

    return {
      exchange: this.name,
      timestamp: new Date().toISOString(),
      totalUsd,
      balance: collateral,
      marginUsed,
      marginFreePercent,
      positionCount: positions.length,
      unrealizedPnl: totalUnrealizedPnl,
      positions,
      raw: account as unknown as Record<string, unknown>,
    };
  }
}
