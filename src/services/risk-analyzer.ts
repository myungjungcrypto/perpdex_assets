import { config } from "../config";
import { ExchangeBalance, RiskAssessment, RiskLevel } from "../exchanges/types";

export function analyzeRisk(balance: ExchangeBalance): RiskAssessment {
  const pct = balance.marginFreePercent;
  let level: RiskLevel = "safe";

  if (pct <= config.risk.criticalPercent) {
    level = "critical";
  } else if (pct <= config.risk.dangerPercent) {
    level = "danger";
  } else if (pct <= config.risk.warningPercent) {
    level = "warning";
  }

  const messages: Record<RiskLevel, string> = {
    safe: "",
    warning: `Margin free at ${pct.toFixed(1)}% — approaching risk zone`,
    danger: `Margin free at ${pct.toFixed(1)}% — liquidation risk!`,
    critical: `MARGIN FREE ${pct.toFixed(1)}% — LIQUIDATION IMMINENT!`,
  };

  const positionSummary = balance.positions
    .map(
      (p) =>
        `${p.market} ${p.side} ${p.size} @ ${p.entryPrice}` +
        (p.liquidationPrice ? ` (liq: ${p.liquidationPrice})` : "")
    )
    .join("\n");

  return {
    exchange: balance.exchange,
    level,
    marginFreePercent: pct,
    message: messages[level],
    details:
      level !== "safe" && positionSummary ? `Positions:\n${positionSummary}` : undefined,
  };
}

export function analyzeAll(balances: ExchangeBalance[]): RiskAssessment[] {
  return balances.map(analyzeRisk);
}
