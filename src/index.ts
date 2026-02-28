import { config } from "./config";
import { ExchangeBalance, ExchangeFetcher } from "./exchanges/types";
import { ParadexFetcher } from "./exchanges/paradex";
import { LighterFetcher } from "./exchanges/lighter";
import { ExtendedFetcher } from "./exchanges/extended";
import { PacificaFetcher } from "./exchanges/pacifica";
import { NadoFetcher } from "./exchanges/nado";
import { O1ExchangeFetcher } from "./exchanges/o1exchange";
import { VariationalFetcher } from "./exchanges/variational";
import { updateBalanceLog, appendSummary, ensureSheetHeaders } from "./services/google-sheets";
import { sendAlerts, sendStartupMessage } from "./services/telegram";
import { analyzeAll } from "./services/risk-analyzer";
import { logger } from "./utils/logger";

const CYCLE_INTERVAL_MS = Number(process.env.CYCLE_INTERVAL_MS ?? 60_000); // default 1 min

const fetchers: ExchangeFetcher[] = [
  new ParadexFetcher(),
  new LighterFetcher(),
  new ExtendedFetcher(),
  new PacificaFetcher(),
  new NadoFetcher(),
  new O1ExchangeFetcher(),
  new VariationalFetcher(),
];

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

async function main(): Promise<void> {
  logger.info("Balance Monitor starting up...");
  logger.info(`Cycle interval: ${CYCLE_INTERVAL_MS / 1000}s`);

  // Ensure sheet headers exist on first run
  try {
    await ensureSheetHeaders();
  } catch (err) {
    logger.error("Failed to initialize Google Sheets", err);
  }

  // Send startup notification
  await sendStartupMessage();

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
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
