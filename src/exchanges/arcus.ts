import axios from "axios";
import { ExchangeBalance, ExchangeFetcher, Position } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Arcus (arcus.xyz) — dYdX Labs × Robinhood Crypto DEX on Robinhood Chain.
// Read path is unauthenticated beyond the API key: GET /v1/account only needs
// the X-API-Key header (the Ed25519 PUBLIC key) — signatures are required for
// mutating requests only. So the .env stores no signing capability at all.
//
//   GET {base}/v1/account?address=0x...   headers: { X-API-Key }
//   → { equity, netDeposits, freeCollateral, ... }
//
// Position fields are parsed defensively (the endpoint reference wasn't
// available); the raw response is logged once so the mapping can be refined.

function num(v: unknown): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function optNum(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

let loggedRawOnce = false;
let loggedMarketsOnce = false;

export class ArcusFetcher implements ExchangeFetcher {
  name = "Arcus";
  enabled: boolean;

  // marketDisplayName -> maintenance margin fraction, refreshed hourly
  private mmfByMarket = new Map<string, number>();
  private mmfFetchedAt = 0;

  constructor() {
    this.enabled = !!config.arcus.apiKey && !!config.arcus.address;
    if (!this.enabled) {
      logger.info("Arcus: API key/address not set — skipping");
    }
  }

  // Maintenance-margin fractions from /v1/markets (dYdX-style). Needed to
  // turn freeCollateral (an INITIAL-margin measure that legitimately goes
  // negative) into a true distance-to-liquidation percentage.
  private async refreshMaintenanceFractions(): Promise<void> {
    if (Date.now() - this.mmfFetchedAt < 60 * 60 * 1000 && this.mmfByMarket.size > 0) {
      return;
    }
    try {
      const res = await axios.get(`${config.arcus.baseUrl}/v1/markets`, {
        headers: { "X-API-Key": config.arcus.apiKey!, Accept: "application/json" },
        timeout: 10000,
      });
      const body = res.data as Record<string, unknown>;
      const rawList = body.markets ?? body;
      const list: Record<string, unknown>[] = Array.isArray(rawList)
        ? (rawList as Record<string, unknown>[])
        : rawList && typeof rawList === "object"
          ? (Object.values(rawList) as Record<string, unknown>[])
          : [];
      if (!loggedMarketsOnce && list.length > 0) {
        loggedMarketsOnce = true;
        logger.info(`Arcus raw market[0]: ${JSON.stringify(list[0]).slice(0, 1000)}`);
      }
      for (const m of list) {
        const name = String(m.marketDisplayName ?? m.displayName ?? m.ticker ?? m.market ?? "");
        const mmf = optNum(
          m.maintenanceMarginFraction ?? m.maintenanceMarginFrac ?? m.mmf
        );
        if (name && mmf !== undefined && mmf > 0 && mmf < 1) {
          this.mmfByMarket.set(name, mmf);
        }
      }
      this.mmfFetchedAt = Date.now();
    } catch (err) {
      logger.warn(`Arcus: markets fetch failed — ${(err as Error).message}`);
    }
  }

  private parsePositions(raw: unknown): { positions: Position[]; pnl: number } {
    // The account endpoint returns positions as an object keyed by marketId;
    // GET /v1/positions may return an array — accept both.
    const arr: Record<string, unknown>[] = Array.isArray(raw)
      ? (raw as Record<string, unknown>[])
      : raw && typeof raw === "object"
        ? (Object.values(raw) as Record<string, unknown>[])
        : [];
    let pnl = 0;
    const positions: Position[] = [];
    for (const p of arr) {
      const size = num(p.size ?? p.quantity ?? p.q);
      if (size === 0) continue;
      const sideRaw = String(p.side ?? "").toUpperCase();
      const side: "long" | "short" =
        sideRaw === "SHORT" || sideRaw === "SELL" || size < 0 ? "short" : "long";
      const mark = optNum(p.markPx ?? p.markPrice ?? p.oraclePrice ?? p.indexPrice);
      const liqPx = optNum(p.liquidationPrice ?? p.liquidationPx ?? p.liqPrice);
      const positionPnl = num(p.unrealizedPnl ?? p.unrealisedPnl ?? p.upnl);
      pnl += positionPnl;

      let liquidationDistancePercent: number | undefined;
      if (mark && liqPx && mark > 0) {
        liquidationDistancePercent = side === "short"
          ? ((liqPx - mark) / mark) * 100
          : ((mark - liqPx) / mark) * 100;
      }

      const modeRaw = String(p.marginMode ?? "").toUpperCase();
      positions.push({
        market: String(p.marketDisplayName ?? p.market ?? p.symbol ?? p.ticker ?? "unknown"),
        side,
        size: Math.abs(size),
        entryPrice: num(p.entryPrice ?? p.avgEntryPrice ?? p.averageEntryPrice),
        markPrice: mark,
        unrealizedPnl: positionPnl,
        liquidationPrice: liqPx,
        liquidationDistancePercent,
        margin: optNum(p.marginUsed),
        marginMode: modeRaw === "ISOLATED" ? "isolated" : modeRaw === "CROSS" ? "cross" : undefined,
        leverage: optNum(p.leverage),
      });
    }
    return { positions, pnl };
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    const res = await axios.get(`${config.arcus.baseUrl}/v1/account`, {
      params: { address: config.arcus.address },
      headers: { "X-API-Key": config.arcus.apiKey!, Accept: "application/json" },
      timeout: 10000,
    });

    const data = res.data as Record<string, unknown>;
    if (!loggedRawOnce) {
      loggedRawOnce = true;
      logger.info(`Arcus raw account: ${JSON.stringify(data).slice(0, 2000)}`);
    }

    const equity = num(data.equity);
    const freeCollateral = num(data.freeCollateral);

    // Positions may be embedded in the account response, or live on a
    // separate endpoint — try embedded first, then /v1/positions.
    let posRaw: unknown = data.positions ?? data.openPositions;
    if (posRaw === undefined) {
      try {
        const posRes = await axios.get(`${config.arcus.baseUrl}/v1/positions`, {
          params: { address: config.arcus.address },
          headers: { "X-API-Key": config.arcus.apiKey!, Accept: "application/json" },
          timeout: 10000,
        });
        posRaw = (posRes.data as Record<string, unknown>).positions ?? posRes.data;
      } catch (err) {
        logger.debug(`Arcus: positions fetch failed — ${(err as Error).message}`);
      }
    }

    const { positions, pnl } = this.parsePositions(posRaw);

    // Distance to liquidation: (equity - maintenance margin) / equity.
    // freeCollateral measures INITIAL margin and goes negative long before
    // liquidation risk is real, so it is only the fallback.
    await this.refreshMaintenanceFractions();
    let maintenanceMargin = 0;
    let mmComplete = positions.length > 0;
    for (const p of positions) {
      const mmf = this.mmfByMarket.get(p.market);
      const mark = p.markPrice ?? p.entryPrice;
      if (mmf === undefined || !mark) {
        mmComplete = false;
        break;
      }
      maintenanceMargin += Math.abs(p.size * mark) * mmf;
    }

    const marginFreePercent = mmComplete && equity > 0
      ? ((equity - maintenanceMargin) / equity) * 100
      : equity > 0
        ? (freeCollateral / equity) * 100
        : 100;

    return {
      exchange: this.name,
      timestamp: new Date().toISOString(),
      totalUsd: equity,
      balance: freeCollateral,
      marginUsed: equity - freeCollateral,
      marginFreePercent,
      positionCount: positions.length,
      unrealizedPnl: pnl,
      positions,
      raw: data,
    };
  }
}
