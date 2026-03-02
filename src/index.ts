import { config } from "./config.js";
import { ExchangeBalance, ExchangeFetcher } from "./exchanges/types.js";
import { ParadexFetcher } from "./exchanges/paradex.js";
import { LighterFetcher } from "./exchanges/lighter.js";
import { ExtendedFetcher } from "./exchanges/extended.js";
import { PacificaFetcher } from "./exchanges/pacifica.js";
import { NadoFetcher } from "./exchanges/nado.js";
import { O1ExchangeFetcher } from "./exchanges/o1exchange.js";
import { VariationalFetcher } from "./exchanges/variational.js";
import { updateBalanceLog, appendSummary, ensureSheetHeaders } from "./services/google-sheets.js";
import { sendAlerts, sendStartupMessage, startTelegramCommandListener, StatusSnapshot } from "./services/telegram.js";
import { analyzeAll } from "./services/risk-analyzer.js";
import { logger } from "./utils/logger.js";

const CYCLE_INTERVAL_MS = Number(process.env.CYCLE_INTERVAL_MS ?? 60_000); // default 1 min

// Build Pacifica fetchers: one per wallet address (supports comma-separated)
const pacificaAddresses = config.pacifica.walletAddresses;
const pacificaFetchers: ExchangeFetcher[] = pacificaAddresses.map((addr, i) => {
  const label = pacificaAddresses.length > 1 ? `Pacifica-${i + 1}` : "Pacifica";
  return new PacificaFetcher(addr, label);
});

const fetchers: ExchangeFetcher[] = [
  new ParadexFetcher(),
  new LighterFetcher(),
  new ExtendedFetcher(),
  ...pacificaFetchers,
  new NadoFetcher(),
  new O1ExchangeFetcher(),
  new VariationalFetcher(),
];

let latestStatus: StatusSnapshot | null = null;

async function run(): Promise<void> {
  const startTime = Date.now();
  logger.info("=== Balance Monitor: cycle start ===");

  const enabledFetchers = fetchers.filter((f) => f.enabled);
  if (enabledFetchers.length === 0) {
    logger.warn("No exchanges enabled. Check your .env configuration.");
    return;
  }

  logger.info(`Fetching from ${enabledFetchers.length} exchanges: ${enabledFetchers.map((f) => f.name).join(", ")}`);

  // Fetch all balances in parallel
  const results = await Promise.allSettled(
    enabledFetchers.map((f) =>
      f.fetchBalance().catch((err) => {
        logger.error(`${f.name}: fetch failed`, err.message ?? err);
        throw err;
      })
    )
  );

  const balances: ExchangeBalance[] = [];
  const errors: string[] = [];

  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      balances.push(result.value);
      logger.info(`${result.value.exchange}: $${result.value.totalUsd.toFixed(2)} (margin free: ${result.value.marginFreePercent.toFixed(1)}%)`);
    } else {
      const name = enabledFetchers[i].name;
      errors.push(name);
      logger.error(`${name}: failed — ${result.reason}`);
    }
  });

  if (balances.length === 0) {
    latestStatus = {
      capturedAt: new Date().toISOString(),
      cycleIntervalMs: CYCLE_INTERVAL_MS,
      enabledExchanges: enabledFetchers.map((f) => f.name),
      balances: [],
      failedExchanges: [...errors],
    };
    logger.error("All exchanges failed. Skipping sheets update.");
    return;
  }

  // Write to Google Sheets
  try {
    await updateBalanceLog(balances);
  } catch (err) {
    logger.error("Google Sheets Balance Log write failed", err);
  }

  // Analyze risk
  const assessments = analyzeAll(balances);
  const alertExchanges = assessments
    .filter((a) => a.level !== "safe")
    .map((a) => `${a.exchange}(${a.level})`);
  const riskByExchange = new Map(assessments.map((a) => [a.exchange, a.level]));

  latestStatus = {
    capturedAt: new Date().toISOString(),
    cycleIntervalMs: CYCLE_INTERVAL_MS,
    enabledExchanges: enabledFetchers.map((f) => f.name),
    balances: balances.map((b) => ({
      exchange: b.exchange,
      totalUsd: b.totalUsd,
      marginFreePercent: b.marginFreePercent,
      positionCount: b.positionCount,
      riskLevel: riskByExchange.get(b.exchange) ?? "safe",
    })),
    failedExchanges: [...errors],
  };

  // Write summary
  try {
    await appendSummary(balances, alertExchanges);
  } catch (err) {
    logger.error("Google Sheets Summary write failed", err);
  }

  // Send Telegram alerts for risky positions
  try {
    await sendAlerts(assessments);
  } catch (err) {
    logger.error("Telegram alerts failed", err);
  }

  const elapsed = Date.now() - startTime;
  logger.info(
    `=== Cycle complete: ${balances.length} OK, ${errors.length} errors, ${elapsed}ms ===`
  );
  if (errors.length > 0) {
    logger.warn(`Failed exchanges: ${errors.join(", ")}`);
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let stopTelegramCommandListener: (() => void) | null = null;

async function main(): Promise<void> {
  logger.info("Balance Monitor starting up...");
  logger.info(`Cycle interval: ${CYCLE_INTERVAL_MS / 1000}s`);

  // Ensure sheet headers exist on first run (skipped if Google Sheets not configured)
  try {
    await ensureSheetHeaders();
  } catch (err) {
    logger.error("Failed to initialize Google Sheets", err);
  }

  // Send startup notification
  await sendStartupMessage();

  // Enable Telegram command polling (/status)
  stopTelegramCommandListener = startTelegramCommandListener(() => latestStatus);

  // Run immediately
  await run();

  // Schedule recurring cycles
  intervalId = setInterval(async () => {
    try {
      await run();
    } catch (err) {
      logger.error("Cycle failed (uncaught)", err);
    }
  }, CYCLE_INTERVAL_MS);

  logger.info("Continuous mode active. Press Ctrl+C to stop.");
}

// Graceful shutdown
function shutdown(signal: string) {
  logger.info(`Received ${signal}. Shutting down...`);
  if (intervalId) clearInterval(intervalId);
  if (stopTelegramCommandListener) stopTelegramCommandListener();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
