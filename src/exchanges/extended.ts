import axios from "axios";
import { ExchangeBalance, ExchangeFetcher, Position } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Extended Exchange (StarkNet): https://api.docs.extended.exchange
// Base URL: https://api.starknet.extended.exchange/api/v1
// Auth: X-Api-Key header for read-only GET requests
// Stark signatures only needed for write operations (orders, withdrawals)
//
// Response wrapper: { status: "OK", data: { ... } }
// All numeric values are strings.
// Entry price field is "openPrice" (not entryPrice).
// marginRatio > 1 = liquidation.

interface ExtendedBalance {
  collateralName: string;
  balance: string;
  equity: string;
  availableForTrade: string;
  availableForWithdrawal: string;
  unrealisedPnl: string;
  initialMargin: string;
  marginRatio: string; // Maintenance Margin / Equity — liquidation when > 1
  exposure: string;
  leverage: string;
  updatedTime: string;
}

interface ExtendedPosition {
  market: string;
  side: "LONG" | "SHORT";
  leverage: string;
  size: string;
  openPrice: string; // entry price
  markPrice: string;
  liquidationPrice: string;
  margin: string;
  unrealisedPnl: string;
  realisedPnl: string;
  adl: string;
}

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
      Accept: "application/json",
    };
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    const base = config.extended.baseUrl;

    const [balanceRes, positionsRes] = await Promise.all([
      axios.get<{ status: string; data: ExtendedBalance }>(`${base}/user/balance`, {
        headers: this.headers,
        timeout: 10000,
      }).catch((err) => {
        // 404 means zero balance, not an error
        if (err.response?.status === 404) {
          return { data: { status: "OK", data: null } };
        }
        throw err;
      }),
      axios.get<{ status: string; data: ExtendedPosition[] }>(`${base}/user/positions`, {
        headers: this.headers,
        timeout: 10000,
      }),
    ]);

    const bal = (balanceRes.data as { status: string; data: ExtendedBalance | null }).data;
    const positionsRaw = positionsRes.data.data ?? [];

    const equity = bal ? Number(bal.equity) : 0;
    const balance = bal ? Number(bal.balance) : 0;
    const availableForTrade = bal ? Number(bal.availableForTrade) : 0;
    const initialMargin = bal ? Number(bal.initialMargin) : 0;
    const marginRatio = bal ? Number(bal.marginRatio) : 0;
    const unrealisedPnlTotal = bal ? Number(bal.unrealisedPnl) : 0;

    // marginRatio = Maintenance Margin / Equity
    // 0 = no positions, 1 = liquidation
    // marginFreePercent = (1 - marginRatio) * 100
    const marginFreePercent = marginRatio > 0 ? (1 - marginRatio) * 100 : 100;

    const positions: Position[] = positionsRaw.map((p) => ({
      market: p.market,
      side: p.side === "SHORT" ? "short" as const : "long" as const,
      size: Math.abs(Number(p.size)),
      entryPrice: Number(p.openPrice),
      markPrice: Number(p.markPrice) || undefined,
      unrealizedPnl: Number(p.unrealisedPnl),
      liquidationPrice: Number(p.liquidationPrice) || undefined,
      margin: Number(p.margin) || undefined,
      leverage: Number(p.leverage) || undefined,
    }));

    return {
      exchange: this.name,
      timestamp: new Date().toISOString(),
      totalUsd: equity,
      balance: availableForTrade,
      marginUsed: initialMargin,
      marginFreePercent,
      positionCount: positions.length,
      unrealizedPnl: unrealisedPnlTotal,
      positions,
      raw: (bal ?? {}) as unknown as Record<string, unknown>,
    };
  }
}
