import axios from "axios";
import { BrokerBalance, BrokerFetcher } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Kiwoom futures account, fetched via the kiwoom_daemon gateway running on the
// Windows EC2 (hynix_samsung_premium repo, windows/kiwoom_daemon.py).
// The daemon wraps Kiwoom OpenAPI+ (OCX) — the only way to reach 선물옵션
// accounts, since the Kiwoom REST API covers domestic spot stock only.
//
//   GET {gwUrl}/balance   headers: { X-Token: gwToken }
//   → { ok, total_krw, deposit_krw, eval_pl_krw, margin_krw, positions: [...] }
//
// Reach the daemon over the VPC private IP; port 8899 must only be open to
// this machine's security group, never the public internet.

interface GatewayBalanceResponse {
  ok: boolean;
  error?: string;
  total_krw?: number;      // 평가예탁총액
  deposit_krw?: number;    // 예수금
  eval_pl_krw?: number;    // 평가손익
  margin_krw?: number;     // 위탁증거금
  positions?: Array<{
    code?: string;
    name?: string;
    qty?: number;
    avg_price?: number;
    current_price?: number;
    eval_pl?: number;
  }>;
}

export class KiwoomFuturesFetcher implements BrokerFetcher {
  name = "KiwoomFutures";
  enabled: boolean;

  constructor() {
    this.enabled = !!config.kiwoomFutures.gwUrl;
    if (!this.enabled) {
      logger.info("KiwoomFutures: gateway URL not set — skipping");
    }
  }

  async fetchBalance(): Promise<BrokerBalance> {
    const res = await axios.get<GatewayBalanceResponse>(
      `${config.kiwoomFutures.gwUrl}/balance`,
      {
        headers: config.kiwoomFutures.gwToken
          ? { "X-Token": config.kiwoomFutures.gwToken }
          : {},
        timeout: 15000,
      }
    );

    const data = res.data;
    if (!data.ok) {
      throw new Error(`KiwoomFutures gateway error: ${data.error ?? "unknown"}`);
    }

    const holdings = (data.positions ?? []).map((p) => ({
      code: String(p.code ?? ""),
      name: String(p.name ?? "unknown"),
      quantity: Number(p.qty ?? 0),
      avgPrice: Number(p.avg_price ?? 0),
      currentPrice: Number(p.current_price ?? 0),
      evalAmount: 0, // futures positions carry margin, not eval amount
      profitLoss: Number(p.eval_pl ?? 0),
      profitRatePercent: 0,
    }));

    return {
      broker: this.name,
      timestamp: new Date().toISOString(),
      totalKrw: Number(data.total_krw ?? 0),
      stockValueKrw: Number(data.margin_krw ?? 0),
      profitLossKrw: Number(data.eval_pl_krw ?? 0),
      profitRatePercent: 0,
      loanKrw: 0,
      holdings,
      raw: data as unknown as Record<string, unknown>,
    };
  }
}
