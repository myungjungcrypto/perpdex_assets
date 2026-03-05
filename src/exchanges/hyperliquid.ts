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

  private async fetchClearinghouseState(dex?: string): Promise<ClearinghouseState> {
    const base = config.hyperliquid.baseUrl;
    const body: Record<string, string> = {
      type: "clearinghouseState",
      user: this.walletAddress,
    };
    if (dex) {
      body.dex = dex;
    }
    const res = await axios.post<ClearinghouseState>(
      `${base}/info`,
      body,
      { timeout: 10000, headers: { "Content-Type": "application/json" } },
    );
    return res.data;
  }

  private parsePositions(data: ClearinghouseState, dexPrefix?: string): Position[] {
    return data.assetPositions
      .filter((ap) => Number(ap.position.szi) !== 0)
      .map((ap) => {
        const p = ap.position;
        const size = Number(p.szi);
        const coin = dexPrefix ? `${dexPrefix}:${p.coin}` : p.coin;
        return {
          market: coin,
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
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    const hip3Dexes = config.hyperliquid.hip3Dexes;

    // Fetch default perps + all HIP-3 dexes in parallel
    const requests = [
      this.fetchClearinghouseState(),
      ...hip3Dexes.map((dex) => this.fetchClearinghouseState(dex)),
    ];
    const results = await Promise.allSettled(requests);

    let totalAccountValue = 0;
    let totalRawUsd = 0;
    let totalMarginUsed = 0;
    const allPositions: Position[] = [];

    results.forEach((result, i) => {
      const dexName = i === 0 ? "default" : hip3Dexes[i - 1];
      if (result.status === "rejected") {
        logger.warn(`${this.name}: failed to fetch dex "${dexName}" — ${result.reason}`);
        return;
      }
      const data = result.value;
      const margin = data.marginSummary;
      totalAccountValue += Number(margin.accountValue);
      totalRawUsd += Number(margin.totalRawUsd);
      totalMarginUsed += Number(margin.totalMarginUsed);

      const dexPrefix = i === 0 ? undefined : hip3Dexes[i - 1];
      allPositions.push(...this.parsePositions(data, dexPrefix));
    });

    const totalUsd = totalAccountValue;
    const balance = totalRawUsd;
    const marginUsed = totalMarginUsed;
    const freeMargin = totalUsd - marginUsed;
    const marginFreePercent = totalUsd > 0 ? (freeMargin / totalUsd) * 100 : 100;
    const unrealizedPnl = allPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

    return {
      exchange: this.name,
      timestamp: new Date().toISOString(),
      totalUsd,
      balance,
      marginUsed,
      marginFreePercent,
      positionCount: allPositions.length,
      unrealizedPnl,
      positions: allPositions,
      raw: {} as Record<string, unknown>,
    };
  }
}
