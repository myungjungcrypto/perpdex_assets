import { config } from "./config.js";
import { ExchangeBalance, ExchangeFetcher } from "./exchanges/types.js";
import { ParadexFetcher } from "./exchanges/paradex.js";
import { LighterFetcher } from "./exchanges/lighter.js";
import { ExtendedFetcher } from "./exchanges/extended.js";
import { PacificaFetcher } from "./exchanges/pacifica.js";
import { NadoFetcher } from "./exchanges/nado.js";
import { O1ExchangeFetcher } from "./exchanges/o1exchange.js";
import { VariationalFetcher } from "./exchanges/variational.js";
import { HyperliquidFetcher } from "./exchanges/hyperliquid.js";
import { BrokerFetcher } from "./brokers/types.js";
import { KiwoomFetcher } from "./brokers/kiwoom.js";
import { KiwoomFuturesFetcher } from "./brokers/kiwoom-futures.js";
import { updateBalanceLog, appendSummary, ensureSheetHeaders, updateBrokerLog, ensureBrokerLogHeaders } from "./services/google-sheets.js";
import { sendAlerts, sendStartupMessage, startTelegramCommandListener, writeStatusToFile, StatusSnapshot } from "./services/telegram.js";
import { analyzeAll } from "./services/risk-analyzer.js";
import { logger } from "./utils/logger.js";

const CYCLE_INTERVAL_MS = Number(process.env.CYCLE_INTERVAL_MS ?? 60_000); // default 1 min

// Build Pacifica fetchers: one per wallet address (supports comma-separated)
const pacificaAddresses = config.pacifica.walletAddresses;
const pacificaFetchers: ExchangeFetcher[] = pacificaAddresses.map((addr, i) => {
  const label = pacificaAddresses.length > 1 ? `Pacifica-${i + 1}` : "Pacifica";
  return new PacificaFetcher(addr, label);
});

// Build Nado fetchers: one per wallet address (supports comma-separated)
const nadoAddresses = config.nado.walletAddresses;
const nadoFetchers: ExchangeFetcher[] = nadoAddresses.map((addr, i) => {
  const label = nadoAddresses.length > 1 ? `Nado-${i + 1}` : "Nado";
  return new NadoFetcher(addr, label);
});

// Build Hyperliquid fetchers: one per wallet address (supports comma-separated)
const hyperliquidAddresses = config.hyperliquid.walletAddresses;
const hyperliquidFetchers: ExchangeFetcher[] = hyperliquidAddresses.map((addr, i) => {
  const label = hyperliquidAddresses.length > 1 ? `Hyperliquid-${i + 1}` : "Hyperliquid";
  return new HyperliquidFetcher(addr, label);
});

const fetchers: ExchangeFetcher[] = [
  new ParadexFetcher(),
  new LighterFetcher(),
  new LighterFetcher(config.lighterRh.roToken, config.lighterRh.baseUrl, "Lighter-RH"),
  new ExtendedFetcher(),
  ...pacificaFetchers,
  ...nadoFetchers,
  new O1ExchangeFetcher(),
  new VariationalFetcher(),
  ...hyperliquidFetchers,
];

// Korean brokerages — polled on a slower cadence than the perp DEXes
const brokerFetchers: BrokerFetcher[] = [new KiwoomFetcher(), new KiwoomFuturesFetcher()];
const BROKER_INTERVAL_MS = config.broker.updateIntervalMinutes * 60_000;
let lastBrokerFetchAt = 0;

async function runBrokers(): Promise<void> {
  const enabled = brokerFetchers.filter((b) => b.enabled);
  if (enabled.length === 0) return;
  if (Date.now() - lastBrokerFetchAt < BROKER_INTERVAL_MS) return;
  lastBrokerFetchAt = Date.now();

  const results = await Promise.allSettled(enabled.map((b) => b.fetchBalance()));
  const balances = results
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<BrokerFetcher["fetchBalance"]>>> => r.status === "fulfilled")
    .map((r) => r.value);

  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      logger.info(`${r.value.broker}: ₩${r.value.totalKrw.toLocaleString()} (${r.value.holdings.length} holdings)`);
    } else {
      logger.error(`${enabled[i].name}: broker fetch failed — ${r.reason}`);
    }
  });

  if (balances.length > 0) {
    try {
      await updateBrokerLog(balances);
    } catch (err) {
      logger.error("Broker Log write failed", err);
    }
  }
}

let latestStatus: StatusSnapshot | null = null;

async function run(): Promise<void> {
  const startTime = Date.now();
  logger.info("=== Balance Monitor: cycle start ===");

  // Brokers run on their own cadence; a failure here must not block exchanges
  runBrokers().catch((err) => logger.error("Broker cycle failed", err));

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
    writeStatusToFile(config.telegram.chatId, latestStatus);
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
  writeStatusToFile(config.telegram.chatId, latestStatus);

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

  if (brokerFetchers.some((b) => b.enabled)) {
    try {
      await ensureBrokerLogHeaders();
    } catch (err) {
      logger.error("Failed to initialize Broker Log sheet", err);
    }
  }

  // Send startup notification
  await sendStartupMessage();

  // Enable Telegram command polling (/status) only when explicitly enabled
  if (config.telegram.enableCommands) {
    stopTelegramCommandListener = startTelegramCommandListener();
  } else {
    logger.info("Telegram command polling disabled (set TELEGRAM_ENABLE_COMMANDS=true to enable /status)");
  }

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
