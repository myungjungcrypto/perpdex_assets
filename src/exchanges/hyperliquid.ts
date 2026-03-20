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

  private async fetchAllMids(dex?: string): Promise<Record<string, string>> {
    const base = config.hyperliquid.baseUrl;
    const body: Record<string, string> = { type: "allMids" };
    if (dex) body.dex = dex;
    const res = await axios.post<Record<string, string>>(
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

  private parsePositions(
    data: ClearinghouseState,
    midPrices: Record<string, string>,
    dexPrefix?: string,
  ): Position[] {
    return data.assetPositions
      .filter((ap) => Number(ap.position.szi) !== 0)
      .map((ap) => {
        const p = ap.position;
        const size = Number(p.szi);
        const coin = dexPrefix ? `${dexPrefix}:${p.coin}` : p.coin;
        const side = size >= 0 ? "long" as const : "short" as const;
        const mark = midPrices[p.coin] ? Number(midPrices[p.coin]) : undefined;
        const liqPx = p.liquidationPx ? Number(p.liquidationPx) : undefined;
        const marginMode = p.leverage?.type === "isolated" ? "isolated" as const : "cross" as const;

        let liquidationDistancePercent: number | undefined;
        if (mark && liqPx && mark > 0) {
          liquidationDistancePercent = side === "short"
            ? ((liqPx - mark) / mark) * 100
            : ((mark - liqPx) / mark) * 100;
        }

        return {
          market: coin,
          side,
          size: Math.abs(size),
          entryPrice: Number(p.entryPx),
          markPrice: mark,
          unrealizedPnl: Number(p.unrealizedPnl),
          liquidationPrice: liqPx,
          liquidationDistancePercent,
          margin: Number(p.marginUsed),
          leverage: p.leverage?.value,
          marginMode,
        };
      });
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    const hip3Dexes = config.hyperliquid.hip3Dexes;

    // Fetch default perps + all HIP-3 dexes + spot + mid prices in parallel
    const perpRequests = [
      this.fetchClearinghouseState(),
      ...hip3Dexes.map((dex) => this.fetchClearinghouseState(dex)),
    ];
    const midRequests = [
      this.fetchAllMids(),
      ...hip3Dexes.map((dex) => this.fetchAllMids(dex)),
    ];
    const [perpResults, midResults, spotResult] = await Promise.all([
      Promise.allSettled(perpRequests),
      Promise.allSettled(midRequests),
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

      if (i === 0) {
        // Default clearinghouseState: accountValue is the overall perp trading
        // equity which already includes collateral locked in HIP-3 dexes.
        // Only take accountValue from here to avoid double-counting.
        totalAccountValue = Number(margin.accountValue);
      }
      // Only count cross margin as "used" for account-level risk.
      // Isolated positions manage their own risk via liquidation distance
      // and should not inflate the account-level margin free %.
      totalMarginUsed += Number(data.crossMarginSummary.totalMarginUsed);

      const midResult = midResults[i];
      const mids = midResult.status === "fulfilled" ? midResult.value : {};
      const dexPrefix = i === 0 ? undefined : hip3Dexes[i - 1];
      allPositions.push(...this.parsePositions(data, mids, dexPrefix));
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
