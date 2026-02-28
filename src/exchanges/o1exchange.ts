import axios from "axios";
import { ExchangeBalance, ExchangeFetcher, Position } from "./types";
import { config } from "../config";
import { logger } from "../utils/logger";

// 01 Exchange (zo protocol) — non-custodial Solana DEX
// Requires running local REST service (zo-ts-rest-api) at localhost:3000
// OR using zo-client SDK for direct on-chain reads.
//
// Response format: { success: true, result: { ... } }
// All field names are camelCase (FTX-style).
// Read-only endpoints (GET /account, /positions, /wallet/balances)
// don't need signing — they read on-chain state for the configured wallet.

interface O1AccountResult {
  collateral: number;
  freeCollateral: number;
  initialMarginRequirement: number;
  maintenanceMarginRequirement: number;
  marginFraction: number;
  openMarginFraction: number;
  totalAccountValue: number;
  totalPositionSize: number;
  liquidating: boolean;
  positions: O1Position[];
}

interface O1Position {
  future: string;
  side: "buy" | "sell";
  size: number;
  netSize: number;
  entryPrice: number;
  unrealizedPnl: number;
  cost: number;
  collateralUsed: number;
}

export class O1ExchangeFetcher implements ExchangeFetcher {
  name = "01Exchange";
  enabled: boolean;

  constructor() {
    // For the local REST service, just needs the base URL to be configured
    // The keypair is configured in the REST service's environment, not here
    this.enabled = !!config.o1.solanaKeypair || !!config.o1.baseUrl;
    if (!this.enabled) {
      logger.warn("01 Exchange: not configured — skipping");
    }
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    const base = config.o1.baseUrl;

    // Local REST service uses its configured keypair internally
    const res = await axios.get<{ success: boolean; result: O1AccountResult }>(
      `${base}/account`,
      { timeout: 10000 }
    );

    if (!res.data.success) {
      throw new Error("01 Exchange: account request failed");
    }

    const account = res.data.result;

    const totalUsd = account.totalAccountValue;
    const freeCollateral = account.freeCollateral;
    const marginUsed = account.collateral - freeCollateral;

    let marginFreePercent = 100;
    if (account.maintenanceMarginRequirement > 0 && account.marginFraction > 0) {
      marginFreePercent =
        ((account.marginFraction - account.maintenanceMarginRequirement) /
          account.marginFraction) *
        100;
    }
    if (account.liquidating) {
      marginFreePercent = 0;
    }

    const positions: Position[] = (account.positions ?? []).map((p) => ({
      market: p.future,
      side: p.netSize >= 0 ? ("long" as const) : ("short" as const),
      size: Math.abs(p.netSize),
      entryPrice: p.entryPrice,
      unrealizedPnl: p.unrealizedPnl,
    }));

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
      raw: account as unknown as Record<string, unknown>,
    };
  }
}
