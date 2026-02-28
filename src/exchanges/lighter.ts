import axios from "axios";
import { ExchangeBalance, ExchangeFetcher, Position } from "./types";
import { config } from "../config";
import { logger } from "../utils/logger";

// Lighter REST API: https://apidocs.lighter.xyz
// Base URL: https://mainnet.zklighter.elliot.ai
// Auth: ro:{account_index}:{scope}:{expiry}:{hex} — no "Bearer" prefix

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

export class LighterFetcher implements ExchangeFetcher {
  name = "Lighter";
  enabled: boolean;

  constructor() {
    this.enabled = !!config.lighter.roToken;
    if (!this.enabled) {
      logger.warn("Lighter: Read-Only token not set — skipping");
    }
  }

  private get headers() {
    return {
      // Lighter uses raw token, no "Bearer" prefix
      Authorization: config.lighter.roToken!,
      Accept: "application/json",
    };
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    const base = config.lighter.baseUrl;

    const accountRes = await axios.get(`${base}/api/v1/account`, {
      headers: this.headers,
      timeout: 10000,
    });

    const data = accountRes.data;

    const collateral = Number(data.collateral ?? 0);
    const positionsRaw: LighterPosition[] = data.positions ?? [];

    // Calculate portfolio value from collateral + unrealized PnL
    let totalUnrealizedPnl = 0;
    const positions: Position[] = positionsRaw.map((p) => {
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

    const totalUsd = collateral + totalUnrealizedPnl;
    // Estimate margin used from position values
    const totalPositionValue = positionsRaw.reduce(
      (sum, p) => sum + Math.abs(Number(p.position_value ?? 0)),
      0
    );
    const marginUsed = positionsRaw.reduce(
      (sum, p) =>
        sum + Math.abs(Number(p.position_value ?? 0)) * Number(p.initial_margin_fraction ?? 0.1),
      0
    );
    const marginFreePercent =
      totalUsd > 0 ? ((totalUsd - marginUsed) / totalUsd) * 100 : 100;

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
      raw: data,
    };
  }
}
