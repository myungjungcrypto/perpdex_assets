import axios from "axios";
import { config } from "../config.js";
import { RiskAssessment, RiskLevel } from "../exchanges/types.js";
import { logger } from "../utils/logger.js";

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

type StatusProvider = () => StatusSnapshot | null;

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
    `${emoji} <b>[${levelLabel}] ${assessment.exchange}</b>`,
    ``,
    `Margin Free: <b>${assessment.marginFreePercent.toFixed(1)}%</b>`,
    assessment.message,
    assessment.details ?? "",
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
    logger.error("Failed to send Telegram alert", err);
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
    logger.error("Failed to send startup message", err);
  }
}

function normalizeCommand(text: string): string {
  const firstToken = text.trim().split(/\s+/)[0] ?? "";
  return firstToken.split("@")[0].toLowerCase();
}

async function handleCommand(
  chatId: number,
  text: string,
  statusProvider: StatusProvider
): Promise<void> {
  const command = normalizeCommand(text);

  if (command === "/status") {
    await sendMessage(chatId, formatStatusText(statusProvider()));
    logger.info(`Telegram /status served for chat ${chatId}`);
    return;
  }

  if (command === "/start" || command === "/help") {
    await sendMessage(chatId, "사용 가능한 명령어:\n/status - 최신 모니터 상태");
  }
}

export function startTelegramCommandListener(
  statusProvider: StatusProvider
): () => void {
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

        if (`${chatId}` !== config.telegram.chatId) {
          logger.warn(`Ignoring Telegram command from unauthorized chat ${chatId}`);
          continue;
        }

        await handleCommand(chatId, text, statusProvider);
      }
    } catch (err) {
      logger.error("Failed to poll Telegram commands", err);
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
    logger.info("Telegram command polling stopped");
  };
}
