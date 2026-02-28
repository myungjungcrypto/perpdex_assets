import { Connection } from "@solana/web3.js";
import { Nord } from "@n1xyz/nord-ts";
import { ExchangeBalance, ExchangeFetcher, Position } from "./types";
import { config } from "../config";
import { logger } from "../utils/logger";

// 01 Exchange — runs on N1 blockchain (migrated from Solana in 2025)
// Uses Nord SDK for read-only balance queries.
// Only wallet public address needed — no private key required.
//
// Flow: getUser(pubkey) → accountIds → getAccount(id) → balances/positions/margins
//
// Margin fields (all in USD):
//   mf  = margin fraction value
//   mmf = maintenance margin fraction value
//   pon = position notional (open position + order size)
//   bankruptcy = true if account can't cover debt
//   Liquidation when mf <= mmf

let nordInstance: Nord | null = null;

async function getNord(): Promise<Nord> {
  if (nordInstance) return nordInstance;

  const connection = new Connection(config.o1.solanaRpcUrl);
  nordInstance = await Nord.new({
    webServerUrl: config.o1.webServerUrl,
    app: config.o1.appKey,
    solanaConnection: connection,
    initWebSockets: false,
  });
  return nordInstance;
}

export class O1ExchangeFetcher implements ExchangeFetcher {
  name = "01Exchange";
  enabled: boolean;

  constructor() {
    this.enabled = !!config.o1.walletAddress;
    if (!this.enabled) {
      logger.warn("01 Exchange: wallet address not set — skipping");
    }
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    let nord: Nord;
    try {
      nord = await getNord();
    } catch (err: unknown) {
      const e = err as Error;
      // Surface the real error instead of opaque AggregateError
      if (e.name === "AggregateError" && "errors" in e) {
        const msgs = (e as AggregateError).errors.map((x: Error) => x.message).join("; ");
        throw new Error(`01Exchange: Nord SDK init failed — ${msgs}`);
      }
      throw new Error(`01Exchange: Nord SDK init failed — ${e.message}`);
    }
    const walletAddress = config.o1.walletAddress!;

    // Get user account IDs by public key (read-only, no signing needed)
    const user = await nord.getUser({ pubkey: walletAddress });
    if (!user || user.accountIds.length === 0) {
      logger.info("01Exchange: no account found for wallet");
      return this.zeroBalance();
    }

    // Get account details for primary account
    const account = await nord.getAccount(user.accountIds[0]);

    // Sum balances (USDC is typically tokenId 0)
    const usdcBalance = account.balances
      .filter((b) => b.token === "USDC" || b.tokenId === 0)
      .reduce((sum, b) => sum + b.amount, 0);

    // Build market ID → symbol map
    const marketMap = new Map<number, string>();
    for (const m of nord.markets) {
      marketMap.set(m.marketId, m.symbol);
    }

    // Parse perp positions
    const positions: Position[] = account.positions
      .filter((p) => p.perp && p.perp.baseSize !== 0)
      .map((p) => {
        const perp = p.perp!;
        const unrealizedPnl = perp.sizePricePnl + perp.fundingPaymentPnl;

        return {
          market: marketMap.get(p.marketId) ?? `market-${p.marketId}`,
          side: perp.isLong ? ("long" as const) : ("short" as const),
          size: Math.abs(perp.baseSize),
          entryPrice: perp.price,
          unrealizedPnl,
        };
      });

    const unrealizedPnl = positions.reduce(
      (sum, p) => sum + p.unrealizedPnl,
      0
    );
    const totalUsd = usdcBalance + unrealizedPnl;

    // Margin health from AccountMarginsView
    const margins = account.margins;
    let marginFreePercent = 100;
    let marginUsed = 0;

    if (margins.pon > 0 && margins.mf > 0) {
      marginUsed = margins.pon;
      // mf = margin fraction, mmf = maintenance margin fraction
      // Liquidation when mf <= mmf, so (1 - mmf/mf) * 100 = distance from liquidation
      const marginRatio = margins.mmf / margins.mf;
      marginFreePercent = (1 - marginRatio) * 100;
    }

    if (margins.bankruptcy) {
      marginFreePercent = 0;
    }

    return {
      exchange: this.name,
      timestamp: new Date().toISOString(),
      totalUsd,
      balance: usdcBalance,
      marginUsed,
      marginFreePercent,
      positionCount: positions.length,
      unrealizedPnl,
      positions,
      raw: { margins, balances: account.balances } as unknown as Record<
        string,
        unknown
      >,
    };
  }

  private zeroBalance(): ExchangeBalance {
    return {
      exchange: this.name,
      timestamp: new Date().toISOString(),
      totalUsd: 0,
      balance: 0,
      marginUsed: 0,
      marginFreePercent: 100,
      positionCount: 0,
      unrealizedPnl: 0,
      positions: [],
      raw: {},
    };
  }
}
