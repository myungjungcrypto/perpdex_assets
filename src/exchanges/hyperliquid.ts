import axios from "axios";
import { ExchangeBalance, ExchangeFetcher, Position } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Hyperliquid Info API: POST https://api.hyperliquid.xyz/info
// All queries use POST with JSON body { "type": "...", "user": "0x..." }
// No authentication required for read-only queries.

interface MarginSummary {
  accountValue: string;
  totalNtlPos: string;
  totalRawUsd: string;
  totalMarginUsed: string;
}

interface AssetPosition {
  position: {
    coin: string;
    szi: string;       // signed size (negative = short)
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    leverage: {
      type: string;
      value: number;
    };
    liquidationPx: string | null;
    marginUsed: string;
  };
  type: string;
}

interface ClearinghouseState {
  marginSummary: MarginSummary;
  crossMarginSummary: MarginSummary;
  assetPositions: AssetPosition[];
  crossMaintenanceMarginUsed: string;
}

export class HyperliquidFetcher implements ExchangeFetcher {
  name: string;
  enabled: boolean;
  private readonly walletAddress: string;

  constructor(address?: string, label?: string) {
    this.walletAddress = address ?? "";
    this.enabled = !!this.walletAddress;
    this.name = label ?? "Hyperliquid";
    if (!this.enabled) {
      logger.warn(`${this.name}: wallet address not set — skipping`);
    }
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    const base = config.hyperliquid.baseUrl;

    const res = await axios.post<ClearinghouseState>(
      `${base}/info`,
      { type: "clearinghouseState", user: this.walletAddress },
      { timeout: 10000, headers: { "Content-Type": "application/json" } },
    );

    const data = res.data;
    const margin = data.marginSummary;

    const accountValue = Number(margin.accountValue);
    const totalMarginUsed = Number(margin.totalMarginUsed);
    const totalRawUsd = Number(margin.totalRawUsd);

    const totalUsd = accountValue;
    const balance = totalRawUsd; // cash balance (deposits - withdrawals + realized PnL)
    const marginUsed = totalMarginUsed;
    const freeMargin = totalUsd - marginUsed;
    const marginFreePercent = totalUsd > 0 ? (freeMargin / totalUsd) * 100 : 100;

    const positions: Position[] = data.assetPositions
      .filter((ap) => Number(ap.position.szi) !== 0)
      .map((ap) => {
        const p = ap.position;
        const size = Number(p.szi);
        return {
          market: p.coin,
          side: size >= 0 ? "long" as const : "short" as const,
          size: Math.abs(size),
          entryPrice: Number(p.entryPx),
          markPrice: undefined,
          unrealizedPnl: Number(p.unrealizedPnl),
          liquidationPrice: p.liquidationPx ? Number(p.liquidationPx) : undefined,
          margin: Number(p.marginUsed),
          leverage: p.leverage?.value,
        };
      });

    const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

    return {
      exchange: this.name,
      timestamp: new Date().toISOString(),
      totalUsd,
      balance,
      marginUsed,
      marginFreePercent,
      positionCount: positions.length,
      unrealizedPnl,
      positions,
      raw: data as unknown as Record<string, unknown>,
    };
  }
}
