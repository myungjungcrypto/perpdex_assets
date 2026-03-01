import axios from "axios";
import { ExchangeBalance, ExchangeFetcher, Position } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Pacifica API response envelope
interface PacificaResponse<T> {
  success: boolean;
  data: T;
  error: string | null;
  code: string | null;
}

interface PacificaAccount {
  balance: string;
  account_equity: string;
  available_to_spend: string;
  available_to_withdraw: string;
  pending_balance: string;
  total_margin_used: string;
  cross_mmr: string;
  positions_count: number;
  orders_count: number;
  updated_at: number;
}

interface PacificaPosition {
  symbol: string;
  side: "bid" | "ask"; // bid = long, ask = short
  amount: string;
  entry_price: string;
  margin: string;
  funding: string;
  isolated: boolean;
  created_at: number;
  updated_at: number;
}

export class PacificaFetcher implements ExchangeFetcher {
  name = "Pacifica";
  enabled: boolean;

  constructor() {
    this.enabled = !!config.pacifica.walletAddress;
    if (!this.enabled) {
      logger.warn("Pacifica: wallet address not set — skipping");
    }
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    const addr = config.pacifica.walletAddress!;
    const base = config.pacifica.baseUrl;

    // GET requests don't require authentication — wallet address is sufficient
    const [accountRes, positionsRes] = await Promise.all([
      axios.get<PacificaResponse<PacificaAccount[]>>(`${base}/api/v1/account`, {
        params: { account: addr },
        timeout: 10000,
      }),
      axios.get<PacificaResponse<PacificaPosition[]>>(`${base}/api/v1/positions`, {
        params: { account: addr },
        timeout: 10000,
      }),
    ]);

    const accountData = accountRes.data;
    const account = Array.isArray(accountData.data)
      ? accountData.data[0]
      : accountData.data;
    if (!account) {
      // Log the response shape to help debug
      const keys = Object.keys(accountData);
      const dataType = typeof accountData.data;
      throw new Error(
        `Pacifica: no account data returned (keys: ${keys.join(",")}, data type: ${dataType}, success: ${accountData.success})`
      );
    }
    const positionsRaw = positionsRes.data.data ?? [];

    const totalUsd = Number(account.account_equity);
    const balance = Number(account.balance);
    const marginUsed = Number(account.total_margin_used);
    const crossMmr = Number(account.cross_mmr);

    // cross_mmr is the cross maintenance margin ratio
    // Higher = more margin used = closer to liquidation
    // marginFreePercent: how safe the account is
    // Note: cross_mmr values observed like 420.69 may be a percentage or ratio
    // We normalize: if > 1 treat as percentage, convert to 0-100 free percent
    let marginFreePercent: number;
    if (crossMmr === 0) {
      marginFreePercent = 100;
    } else if (crossMmr > 1) {
      // cross_mmr expressed as percentage points (e.g. 420 = 420%)
      // Safe when high, danger when approaching 100 (100% of maintenance used)
      marginFreePercent = totalUsd > 0 ? ((totalUsd - marginUsed) / totalUsd) * 100 : 100;
    } else {
      // cross_mmr as ratio 0-1
      marginFreePercent = (1 - crossMmr) * 100;
    }

    // unrealized_pnl is not on positions; derive from account_equity - balance
    const unrealizedPnl = totalUsd - balance;

    const positions: Position[] = positionsRaw.map((p) => ({
      market: p.symbol,
      side: p.side === "bid" ? "long" as const : "short" as const,
      size: Math.abs(Number(p.amount)),
      entryPrice: Number(p.entry_price),
      unrealizedPnl: 0, // not provided per-position
    }));

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
      raw: account as unknown as Record<string, unknown>,
    };
  }
}
