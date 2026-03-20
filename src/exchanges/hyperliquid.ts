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

interface SpotBalance {
  coin: string;
  hold: string;
  total: string;
  entryNtl: string;
  token: number;
}

interface SpotClearinghouseState {
  balances: SpotBalance[];
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

  private async fetchSpotState(): Promise<SpotClearinghouseState> {
    const base = config.hyperliquid.baseUrl;
    const res = await axios.post<SpotClearinghouseState>(
      `${base}/info`,
      { type: "spotClearinghouseState", user: this.walletAddress },
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

    // Fetch default perps + all HIP-3 dexes + spot in parallel
    const perpRequests = [
      this.fetchClearinghouseState(),
      ...hip3Dexes.map((dex) => this.fetchClearinghouseState(dex)),
    ];
    const [perpResults, spotResult] = await Promise.all([
      Promise.allSettled(perpRequests),
      this.fetchSpotState().catch((err) => {
        logger.warn(`${this.name}: failed to fetch spot state — ${err}`);
        return null;
      }),
    ]);

    let totalAccountValue = 0;
    let totalMarginUsed = 0;
    const allPositions: Position[] = [];

    perpResults.forEach((result, i) => {
      const dexName = i === 0 ? "default" : hip3Dexes[i - 1];
      if (result.status === "rejected") {
        logger.warn(`${this.name}: failed to fetch dex "${dexName}" — ${result.reason}`);
        return;
      }
      const data = result.value;
      const margin = data.marginSummary;
      // accountValue already excludes isolated-margin collateral,
      // so use crossMarginSummary to avoid double-subtracting isolated margin.
      const crossMargin = data.crossMarginSummary;
      totalAccountValue += Number(margin.accountValue);
      totalMarginUsed += Number(crossMargin.totalMarginUsed);

      const dexPrefix = i === 0 ? undefined : hip3Dexes[i - 1];
      allPositions.push(...this.parsePositions(data, dexPrefix));
    });

    // Add spot balances to total equity
    // USDC (and other stablecoins) count as 1:1 USD value
    // Non-stablecoin spot tokens use their entryNtl (notional value) as approximation
    let spotUsdValue = 0;
    if (spotResult?.balances) {
      for (const bal of spotResult.balances) {
        const total = Number(bal.total);
        if (total === 0) continue;
        if (bal.coin === "USDC" || bal.coin === "USDT" || bal.coin === "USDCE") {
          spotUsdValue += total;
        } else {
          // entryNtl is the USD notional value at entry; use as approximation
          spotUsdValue += Number(bal.entryNtl || 0);
        }
      }
    }

    const perpsEquity = totalAccountValue;
    const totalUsd = perpsEquity + spotUsdValue;
    const marginUsed = totalMarginUsed;
    const balance = totalUsd - marginUsed; // free collateral (consistent with other exchanges)
    const marginFreePercent = totalUsd > 0 ? (balance / totalUsd) * 100 : 100;
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
