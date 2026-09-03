import axios from "axios";
import { config } from "../config.js";
import { sendPlainMessage } from "./telegram.js";
import { logger } from "../utils/logger.js";

// Variational Omni long-entry capacity watcher.
//
// Uses the PUBLIC market-stats API only (no account, no keys, no order risk):
//   GET {VARIATIONAL_BASE_URL}/metadata/stats
//   → { listings: [{ ticker, mark_price, funding_rate,
//        open_interest: { long_open_interest, short_open_interest },
//        quotes: { size_1k: {bid, ask}, size_100k: {...}, size_1m: {...} } }] }
//
// A ticker is considered "enterable long" when its ask quote exists at the
// configured size tier — Omni is OLP-quote-driven, so a missing/blank ask at
// size means the pool can't take that much new long exposure right now.
// Alerts are edge-triggered (blocked → available) with a cooldown, and re-arm
// when the market closes up again.

interface OmniQuoteSide {
  bid?: string | number | null;
  ask?: string | number | null;
}

interface OmniListing {
  ticker?: string;
  name?: string;
  mark_price?: string | number;
  funding_rate?: string | number;
  open_interest?: {
    long_open_interest?: string | number;
    short_open_interest?: string | number;
  };
  quotes?: Record<string, OmniQuoteSide | undefined>;
}

interface OmniStats {
  listings?: OmniListing[];
}

// ticker -> { available, lastAlertAt }
const watchState = new Map<string, { available: boolean; lastAlertAt: number }>();
let loggedRawOnce = false;

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function askAvailable(listing: OmniListing, sizeTier: string): boolean {
  const q = listing.quotes?.[`size_${sizeTier}`];
  return num(q?.ask) !== null;
}

export async function checkVariationalOpportunities(): Promise<void> {
  const tickers = config.variationalWatch.tickers;
  if (tickers.length === 0) return;

  let stats: OmniStats;
  try {
    const res = await axios.get<OmniStats>(
      `${config.variational.baseUrl}/metadata/stats`,
      { timeout: 10000, headers: { Accept: "application/json" } },
    );
    stats = res.data;
  } catch (err) {
    logger.warn(`Variational watch: stats fetch failed — ${(err as Error).message}`);
    return;
  }

  const listings = stats.listings ?? [];
  const sizeTier = config.variationalWatch.sizeTier;
  const cooldownMs = config.variationalWatch.cooldownMinutes * 60_000;

  for (const ticker of tickers) {
    const listing = listings.find(
      (l) => (l.ticker ?? "").toUpperCase() === ticker
    );
    if (!listing) {
      logger.debug(`Variational watch: ${ticker} not listed`);
      continue;
    }

    // One-time raw dump so the actual field shape (e.g. any OI-cap field)
    // can be inspected in the logs and the detection rule refined.
    if (!loggedRawOnce) {
      loggedRawOnce = true;
      logger.info(`Variational watch raw listing: ${JSON.stringify(listing)}`);
    }

    const available = askAvailable(listing, sizeTier);
    const prev = watchState.get(ticker) ?? { available: true, lastAlertAt: 0 };
    const now = Date.now();

    if (available && !prev.available && now - prev.lastAlertAt >= cooldownMs) {
      const mark = num(listing.mark_price);
      const funding = num(listing.funding_rate);
      const longOi = num(listing.open_interest?.long_open_interest);
      const shortOi = num(listing.open_interest?.short_open_interest);
      const lines = [
        `\u{1F7E2} <b>Variational ${ticker} 롱 자리 생겼음</b>`,
        `$${sizeTier} 사이즈 ask 호가 활성화`,
        mark !== null ? `Mark: $${mark}` : "",
        funding !== null ? `Funding: ${(funding * 100).toFixed(4)}%/h` : "",
        longOi !== null && shortOi !== null
          ? `OI long $${longOi.toLocaleString()} / short $${shortOi.toLocaleString()}`
          : "",
      ].filter(Boolean);
      await sendPlainMessage(lines.join("\n"));
      logger.info(`Variational watch: ${ticker} long capacity opened — alert sent`);
      watchState.set(ticker, { available, lastAlertAt: now });
    } else {
      watchState.set(ticker, { available, lastAlertAt: prev.lastAlertAt });
    }
  }
}
