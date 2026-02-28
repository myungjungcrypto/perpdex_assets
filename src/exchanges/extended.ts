import axios from "axios";
import { ExchangeBalance, ExchangeFetcher, Position } from "./types";
import { config } from "../config";
import { logger } from "../utils/logger";

export class ExtendedFetcher implements ExchangeFetcher {
  name = "Extended";
  enabled: boolean;

  constructor() {
    this.enabled = !!config.extended.apiKey;
    if (!this.enabled) {
      logger.warn("Extended: API key not set — skipping");
    }
  }

  private get headers() {
    return {
      "X-Api-Key": config.extended.apiKey!,
      "User-Agent": "perpdex-balance-monitor/1.0",
      Accept: "application/json",
    };
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    const base = config.extended.baseUrl;

    const [accountRes, positionsRes] = await Promise.all([
      axios.get(`${base}/v1/private/account`, {
        headers: this.headers,
        timeout: 10000,
      }),
      axios.get(`${base}/v1/private/positions`, {
        headers: this.headers,
        timeout: 10000,
      }),
    ]);

    const account = accountRes.data;
    const positionsRaw = positionsRes.data?.positions ?? positionsRes.data?.results ?? positionsRes.data ?? [];

    const totalUsd = Number(account.account_value ?? account.equity ?? account.total_equity ?? 0);
    const freeCollateral = Number(account.free_collateral ?? account.available_balance ?? 0);
    const marginUsed = Number(account.margin_used ?? account.initial_margin ?? 0);
    const maintenanceMargin = Number(account.maintenance_margin ?? 0);

    // marginFreePercent = ((equity - maintenance_margin) / equity) * 100
    const marginFreePercent =
      totalUsd > 0 ? ((totalUsd - maintenanceMargin) / totalUsd) * 100 : 100;

    const positions: Position[] = Array.isArray(positionsRaw)
      ? positionsRaw.map((p: Record<string, unknown>) => ({
          market: String(p.market ?? p.symbol ?? "unknown"),
          side: Number(p.size ?? p.quantity ?? 0) >= 0 ? "long" as const : "short" as const,
          size: Math.abs(Number(p.size ?? p.quantity ?? 0)),
          entryPrice: Number(p.entry_price ?? p.avg_entry_price ?? 0),
          markPrice: Number(p.mark_price ?? 0) || undefined,
          unrealizedPnl: Number(p.unrealized_pnl ?? p.pnl ?? 0),
          liquidationPrice: Number(p.liquidation_price ?? 0) || undefined,
          margin: Number(p.margin ?? 0) || undefined,
          leverage: Number(p.leverage ?? 0) || undefined,
        }))
      : [];

    const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

    return {
      exchange: this.name,
      timestamp: new Date().toISOString(),
      totalUsd,
      balance: freeCollateral,
      marginUsed,
      marginFreePercent,
      positionCount: positions.length,
      unrealizedPnl,
      positions,
      raw: account,
    };
  }
}
