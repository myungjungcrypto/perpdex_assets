import axios from "axios";
import { ExchangeBalance, ExchangeFetcher, Position } from "./types";
import { config } from "../config";
import { logger } from "../utils/logger";

export class ParadexFetcher implements ExchangeFetcher {
  name = "Paradex";
  enabled: boolean;

  constructor() {
    this.enabled = !!config.paradex.jwtToken;
    if (!this.enabled) {
      logger.warn("Paradex: JWT token not set — skipping");
    }
  }

  private get headers() {
    return {
      Authorization: `Bearer ${config.paradex.jwtToken}`,
      Accept: "application/json",
    };
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    const base = config.paradex.baseUrl;

    const [accountRes, positionsRes] = await Promise.all([
      axios.get(`${base}/account`, {
        headers: this.headers,
        timeout: 10000,
      }),
      axios.get(`${base}/positions`, {
        headers: this.headers,
        timeout: 10000,
      }),
    ]);

    const account = accountRes.data;
    const positionsRaw = positionsRes.data?.results ?? positionsRes.data ?? [];

    const totalUsd = Number(account.account_value ?? 0);
    const freeCollateral = Number(account.free_collateral ?? 0);
    const initialMarginReq = Number(account.initial_margin_requirement ?? 0);
    const maintenanceMarginReq = Number(account.maintenance_margin_requirement ?? 0);
    const marginCushion = Number(account.margin_cushion ?? 0);

    // margin_cushion is account_value - maintenance_margin
    // marginFreePercent = (margin_cushion / account_value) * 100
    const marginFreePercent =
      totalUsd > 0 ? (marginCushion / totalUsd) * 100 : 100;
    const marginUsed = totalUsd - freeCollateral;

    // Paradex positions: side is "LONG"/"SHORT", size is signed string
    const positions: Position[] = Array.isArray(positionsRaw)
      ? positionsRaw.map((p: Record<string, unknown>) => ({
          market: String(p.market ?? "unknown"),
          side: String(p.side) === "SHORT" || Number(p.size ?? 0) < 0 ? "short" as const : "long" as const,
          size: Math.abs(Number(p.size ?? 0)),
          entryPrice: Number(p.average_entry_price ?? 0),
          unrealizedPnl: Number(p.unrealized_pnl ?? 0),
          liquidationPrice: Number(p.liquidation_price ?? 0) || undefined,
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
