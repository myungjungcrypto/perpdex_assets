import axios from "axios";
import { config } from "../config";
import { RiskAssessment, RiskLevel } from "../exchanges/types";
import { logger } from "../utils/logger";

const LEVEL_EMOJI: Record<RiskLevel, string> = {
  safe: "",
  warning: "\u{1F7E1}",
  danger: "\u{1F7E0}",
  critical: "\u{1F534}\u{1F6A8}",
};

// In-memory cooldown tracker: exchange -> { level, lastSent }
const cooldowns = new Map<
  string,
  { level: RiskLevel; lastSent: number }
>();

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

function levelSeverity(level: RiskLevel): number {
  return { safe: 0, warning: 1, danger: 2, critical: 3 }[level];
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
    await axios.post(
      `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
      {
        chat_id: config.telegram.chatId,
        text,
        parse_mode: "HTML",
      }
    );

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
    await axios.post(
      `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
      {
        chat_id: config.telegram.chatId,
        text: `\u{2705} <b>Balance Monitor Started</b>\nMonitoring exchanges every 1 minute.`,
        parse_mode: "HTML",
      }
    );
  } catch (err) {
    logger.error("Failed to send startup message", err);
  }
}
