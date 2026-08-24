import axios from "axios";
import { BrokerBalance, BrokerFetcher, BrokerHolding } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Kiwoom Securities REST API (openapi.kiwoom.com)
//
// Auth:    POST /oauth2/token  { grant_type, appkey, secretkey }
//          → { token, token_type, expires_dt (yyyyMMddHHmmss KST) }
// Balance: POST /api/dostk/acnt  headers { authorization, api-id: kt00018 }
//          body { qry_tp: "1", dmst_stex_tp: "KRX" }
//          → tot_evlt_amt, tot_evlt_pl, tot_prft_rt, prsm_dpst_aset_amt,
//            tot_loan_amt, tot_crd_loan_amt, acnt_evlt_remn_indv_tot[]
//
// NOTE: Kiwoom API keys carry order permissions (no read-only scope exists).
// Keep the .env file private (chmod 600) and never commit it.

interface KiwoomTokenResponse {
  token?: string;
  token_type?: string;
  expires_dt?: string;
  return_code?: number;
  return_msg?: string;
}

// Numeric fields arrive as zero-padded strings, e.g. "000005724100000"
function num(v: unknown): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : 0;
}

// expires_dt is local KST (yyyyMMddHHmmss)
function parseExpiresDt(expiresDt: string): number {
  const m = expiresDt.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return Date.now() + 12 * 60 * 60 * 1000; // fallback: assume 12h
  const [, y, mo, d, h, mi, s] = m;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}+09:00`);
}

export class KiwoomFetcher implements BrokerFetcher {
  name = "Kiwoom";
  enabled: boolean;

  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor() {
    this.enabled = !!config.kiwoom.appKey && !!config.kiwoom.appSecret;
    if (!this.enabled) {
      logger.info("Kiwoom: app key/secret not set — skipping");
    }
  }

  private async getToken(): Promise<string> {
    // Reissue 60s before expiry
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.token;
    }

    const res = await axios.post<KiwoomTokenResponse>(
      `${config.kiwoom.baseUrl}/oauth2/token`,
      {
        grant_type: "client_credentials",
        appkey: config.kiwoom.appKey,
        secretkey: config.kiwoom.appSecret,
      },
      {
        headers: { "Content-Type": "application/json;charset=UTF-8" },
        timeout: 10000,
      }
    );

    const data = res.data;
    if (!data.token) {
      throw new Error(
        `Kiwoom token issuance failed: ${data.return_msg ?? "no token in response"}`
      );
    }

    this.token = data.token;
    this.tokenExpiresAt = data.expires_dt
      ? parseExpiresDt(data.expires_dt)
      : Date.now() + 12 * 60 * 60 * 1000;

    logger.info("Kiwoom: access token issued");
    return data.token;
  }

  async fetchBalance(): Promise<BrokerBalance> {
    const token = await this.getToken();

    const res = await axios.post(
      `${config.kiwoom.baseUrl}/api/dostk/acnt`,
      { qry_tp: "1", dmst_stex_tp: "KRX" },
      {
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          authorization: `Bearer ${token}`,
          "api-id": "kt00018",
          "cont-yn": "N",
          "next-key": "",
        },
        timeout: 15000,
      }
    );

    const data = res.data as Record<string, unknown>;
    const returnCode = num(data.return_code);
    if (returnCode !== 0) {
      // Token may have been revoked server-side — drop cache so next cycle reissues
      if (returnCode === 3 || returnCode === 8) this.token = null;
      throw new Error(`Kiwoom kt00018 failed: code=${returnCode} ${data.return_msg ?? ""}`);
    }

    const holdingsRaw = Array.isArray(data.acnt_evlt_remn_indv_tot)
      ? (data.acnt_evlt_remn_indv_tot as Record<string, unknown>[])
      : [];

    const holdings: BrokerHolding[] = holdingsRaw
      .filter((h) => num(h.rmnd_qty) > 0)
      .map((h) => ({
        code: String(h.stk_cd ?? "").replace(/^A/, ""),
        name: String(h.stk_nm ?? "unknown"),
        quantity: num(h.rmnd_qty),
        avgPrice: num(h.pur_pric),
        currentPrice: num(h.cur_prc),
        evalAmount: num(h.evlt_amt),
        profitLoss: num(h.evltv_prft),
        profitRatePercent: num(h.prft_rt),
      }));

    return {
      broker: this.name,
      timestamp: new Date().toISOString(),
      totalKrw: num(data.prsm_dpst_aset_amt),
      stockValueKrw: num(data.tot_evlt_amt),
      profitLossKrw: num(data.tot_evlt_pl),
      profitRatePercent: num(data.tot_prft_rt),
      loanKrw: num(data.tot_loan_amt) + num(data.tot_crd_loan_amt),
      holdings,
      raw: {
        tot_pur_amt: data.tot_pur_amt,
        tot_evlt_amt: data.tot_evlt_amt,
        tot_evlt_pl: data.tot_evlt_pl,
        tot_prft_rt: data.tot_prft_rt,
        prsm_dpst_aset_amt: data.prsm_dpst_aset_amt,
        tot_loan_amt: data.tot_loan_amt,
        tot_crd_loan_amt: data.tot_crd_loan_amt,
      },
    };
  }
}
