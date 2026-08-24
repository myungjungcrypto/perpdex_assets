import axios from "axios";
import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { RiskAssessment, RiskLevel } from "../exchanges/types.js";
import { logger } from "../utils/logger.js";

const STATUS_DIR = path.join(process.cwd(), "tmp");
const LOCK_FILE = path.join(STATUS_DIR, "telegram-poll.lock");

const LEVEL_EMOJI: Record<RiskLevel, string> = {
  safe: "",
  warning: "\u{1F7E1}",
  danger: "\u{1F7E0}",
  critical: "\u{1F534}\u{1F6A8}",
};

export interface StatusExchange {
  exchange: string;
  totalUsd: number;
  marginFreePercent: number;
  positionCount: number;
  riskLevel: RiskLevel;
}

export interface StatusSnapshot {
  capturedAt: string;
  cycleIntervalMs: number;
  enabledExchanges: string[];
  balances: StatusExchange[];
  failedExchanges: string[];
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat?: { id: number };
    text?: string;
  };
}

interface TelegramUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

function describeAxiosError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const desc = (err.response?.data as { description?: string } | undefined)?.description;
    return `status=${status ?? "unknown"}${desc ? ` (${desc})` : ""}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

// ── File-based status sharing (multi-process safe) ──

export function writeStatusToFile(chatId: string, status: StatusSnapshot): void {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(STATUS_DIR, `status-${chatId}.json`),
    JSON.stringify(status),
  );
}

function readStatusFromFile(chatId: string | number): StatusSnapshot | null {
  try {
    const raw = fs.readFileSync(
      path.join(STATUS_DIR, `status-${chatId}.json`),
      "utf-8",
    );
    return JSON.parse(raw) as StatusSnapshot;
  } catch {
    return null;
  }
}

function hasStatusFile(chatId: string | number): boolean {
  return fs.existsSync(path.join(STATUS_DIR, `status-${chatId}.json`));
}

// ── PID-file lock: only one process may poll getUpdates ──

function tryAcquireLock(): boolean {
  fs.mkdirSync(STATUS_DIR, { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      process.kill(pid, 0); // throws if PID is not running
      return false;
    } catch {
      // stale lock — previous process died
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  return true;
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch { /* best-effort */ }
}

// In-memory cooldown tracker: exchange -> { level, lastSent }
const cooldowns = new Map<
  string,
  { level: RiskLevel; lastSent: number }
>();

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function levelSeverity(level: RiskLevel): number {
  return { safe: 0, warning: 1, danger: 2, critical: 3 }[level];
}

function formatStatusText(status: StatusSnapshot | null): string {
  if (!status) {
    return [
      "<b>Balance Monitor Status</b>",
      "아직 수집된 데이터가 없습니다.",
      "잠시 후 다시 /status 를 입력해 주세요.",
    ].join("\n");
  }

  const totalUsd = status.balances.reduce((sum, b) => sum + b.totalUsd, 0);
  const riskyCount = status.balances.filter((b) => b.riskLevel !== "safe").length;
  const sorted = [...status.balances].sort(
    (a, b) =>
      levelSeverity(b.riskLevel) - levelSeverity(a.riskLevel) ||
      a.marginFreePercent - b.marginFreePercent
  );

  const lines = sorted.map(
    (b) =>
      `${LEVEL_EMOJI[b.riskLevel] || "\u{2705}"} <b>${escapeHtml(b.exchange)}</b> | free <b>${b.marginFreePercent.toFixed(1)}%</b> | $${b.totalUsd.toFixed(2)} | pos ${b.positionCount}`
  );

  const failedText =
    status.failedExchanges.length > 0
      ? `Failed: ${status.failedExchanges.map(escapeHtml).join(", ")}`
      : "Failed: none";

  return [
    "<b>Balance Monitor Status</b>",
    `Updated: ${escapeHtml(status.capturedAt)}`,
    `Cycle: ${(status.cycleIntervalMs / 1000).toFixed(0)}s`,
    `Enabled: ${status.enabledExchanges.length} | OK: ${status.balances.length} | Risky: ${riskyCount}`,
    `Total Equity: <b>$${totalUsd.toFixed(2)}</b>`,
    failedText,
    "",
    "<b>Exchanges</b>",
    ...(lines.length > 0 ? lines : ["No successful balance fetches in latest cycle."]),
  ].join("\n");
}

function shouldSend(assessment: RiskAssessment): boolean {
  if (assessment.level === "safe") return false;

  const prev = cooldowns.get(assessment.exchange);
  const now = Date.now();
  const cooldownMs = config.risk.alertCooldownMinutes * 60 * 1000;

  // Always send if level escalated
  if (prev && levelSeverity(assessment.level) > levelSeverity(prev.level)) {
    return true;
  }

  // Critical always sends
  if (assessment.level === "critical") return true;

  // Danger sends every 5 min (no cooldown)
  if (assessment.level === "danger") return true;

  // Warning: respect cooldown
  if (prev && now - prev.lastSent < cooldownMs) return false;

  return true;
}

async function sendMessage(chatId: string | number, text: string): Promise<void> {
  await axios.post(
    `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }
  );
}

export async function sendAlert(assessment: RiskAssessment): Promise<void> {
  if (!shouldSend(assessment)) return;

  const emoji = LEVEL_EMOJI[assessment.level];
  const levelLabel = assessment.level.toUpperCase();
  const text = [
    `${emoji} <b>[${levelLabel}] ${escapeHtml(assessment.exchange)}</b>`,
    ``,
    `Margin Free: <b>${assessment.marginFreePercent.toFixed(1)}%</b>`,
    assessment.message ? escapeHtml(assessment.message) : "",
    assessment.details ? escapeHtml(assessment.details) : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    await sendMessage(config.telegram.chatId, text);

    cooldowns.set(assessment.exchange, {
      level: assessment.level,
      lastSent: Date.now(),
    });

    logger.info(`Telegram alert sent: ${assessment.exchange} [${levelLabel}]`);
  } catch (err) {
    logger.error(`Failed to send Telegram alert (${describeAxiosError(err)})`);
  }
}

export async function sendAlerts(
  assessments: RiskAssessment[]
): Promise<void> {
  const risky = assessments.filter((a) => a.level !== "safe");
  for (const assessment of risky) {
    await sendAlert(assessment);
  }
}

export async function sendStartupMessage(): Promise<void> {
  try {
    await sendMessage(
      config.telegram.chatId,
      `\u{2705} <b>Balance Monitor Started</b>\nMonitoring exchanges every 1 minute.`
    );
  } catch (err) {
    logger.error(`Failed to send startup message (${describeAxiosError(err)})`);
  }
}

function normalizeCommand(text: string): string {
  const firstToken = text.trim().split(/\s+/)[0] ?? "";
  return firstToken.split("@")[0].toLowerCase();
}

async function handleCommand(
  chatId: number,
  text: string,
): Promise<void> {
  const command = normalizeCommand(text);

  if (command === "/status") {
    const status = readStatusFromFile(chatId);
    await sendMessage(chatId, formatStatusText(status));
    logger.info(`Telegram /status served for chat ${chatId}`);
    return;
  }

  if (command === "/start" || command === "/help") {
    await sendMessage(chatId, "사용 가능한 명령어:\n/status - 최신 모니터 상태");
  }
}

export function startTelegramCommandListener(): () => void {
  // Only one process may poll getUpdates per bot token
  if (!tryAcquireLock()) {
    logger.info("Telegram command polling: another process holds the lock — skipping");
    return () => {};
  }

  logger.info("Telegram command polling: acquired lock (this process is the poller)");

  let lastUpdateId = 0;
  let polling = false;
  const intervalMs =
    Number.isFinite(config.telegram.commandPollIntervalMs) &&
    config.telegram.commandPollIntervalMs > 0
      ? config.telegram.commandPollIntervalMs
      : 5000;

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const res = await axios.get<TelegramUpdatesResponse>(
        `https://api.telegram.org/bot${config.telegram.botToken}/getUpdates`,
        {
          params: {
            offset: lastUpdateId + 1,
            timeout: 0,
            allowed_updates: JSON.stringify(["message"]),
          },
        }
      );

      if (!res.data.ok) return;

      for (const update of res.data.result) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);

        const chatId = update.message?.chat?.id;
        const text = update.message?.text;
        if (chatId === undefined || !text) continue;

        // Accept any chatId that has a status file (= registered user)
        if (!hasStatusFile(chatId)) {
          logger.warn(`Ignoring Telegram command from unknown chat ${chatId}`);
          continue;
        }

        await handleCommand(chatId, text);
      }
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        // Lock may have been stolen by another process (e.g. after restart race)
        logger.warn("Telegram polling 409 — releasing lock and stopping");
        releaseLock();
        clearInterval(timer);
      } else {
        logger.error(`Failed to poll Telegram commands (${describeAxiosError(err)})`);
      }
    } finally {
      polling = false;
    }
  };

  void poll();
  const timer = setInterval(() => {
    void poll();
  }, intervalMs);
  logger.info(`Telegram command polling active: interval ${intervalMs}ms`);

  return () => {
    clearInterval(timer);
    releaseLock();
    logger.info("Telegram command polling stopped, lock released");
  };
}
