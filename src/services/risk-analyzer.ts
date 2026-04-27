import { config } from "../config.js";
import { ExchangeBalance, Position, RiskAssessment, RiskLevel } from "../exchanges/types.js";

function getCoinName(market: string): string {
  // Strip dex prefix (e.g. "hyperliquidDex:XYZ100" -> "XYZ100")
  const parts = market.split(":");
  return (parts.length > 1 ? parts[parts.length - 1] : market).toUpperCase();
}

function isXyzMarket(market: string): boolean {
  const prefix = config.risk.positionXyzPrefix;
  return prefix.length > 0 && market.toLowerCase().startsWith(prefix);
}

function positionRiskLevel(p: Position): RiskLevel {
  if (p.liquidationDistancePercent == null) return "safe";
  const dist = p.liquidationDistancePercent;
  const coin = getCoinName(p.market);
  const custom = config.risk.positionCustomDistances[coin];
  // Priority: per-coin override > xyz: prefix override > global defaults
  const xyz = !custom && isXyzMarket(p.market);
  const criticalDist = custom?.critical
    ?? (xyz ? config.risk.positionXyzCriticalDistance : config.risk.positionCriticalDistance);
  const dangerDist = custom?.danger
    ?? (xyz ? config.risk.positionXyzDangerDistance : config.risk.positionDangerDistance);
  const warningDist = custom?.warning
    ?? (xyz ? config.risk.positionXyzWarningDistance : config.risk.positionWarningDistance);
  if (dist <= criticalDist) return "critical";
  if (dist <= dangerDist) return "danger";
  if (dist <= warningDist) return "warning";
  return "safe";
}

const LEVEL_SEVERITY: Record<RiskLevel, number> = { safe: 0, warning: 1, danger: 2, critical: 3 };

function positionRiskEmoji(level: RiskLevel): string {
  return { safe: "\u{2705}", warning: "\u{26A0}\u{FE0F}", danger: "\u{1F7E0}", critical: "\u{1F534}" }[level];
}

function formatPositionLine(p: Position): string {
  const pLevel = positionRiskLevel(p);
  const emoji = positionRiskEmoji(pLevel);
  const mode = p.marginMode === "isolated" ? " [iso]" : "";
  const lev = p.leverage ? ` ${p.leverage}x` : "";
  const mark = p.markPrice != null ? p.markPrice : p.entryPrice;
  const liqStr = p.liquidationPrice != null
    ? ` liq ${p.liquidationPrice}`
    : "";
  const distStr = p.liquidationDistancePercent != null
    ? ` (${p.liquidationDistancePercent.toFixed(1)}% away)`
    : "";
  return `${emoji} ${p.market} ${p.side}${lev}${mode} ${p.size} @ ${mark}${liqStr}${distStr}`;
}

export function analyzeRisk(balance: ExchangeBalance): RiskAssessment {
  const pct = balance.marginFreePercent;

  // Overall margin-level risk
  let level: RiskLevel = "safe";
  if (pct <= config.risk.criticalPercent) {
    level = "critical";
  } else if (pct <= config.risk.dangerPercent) {
    level = "danger";
  } else if (pct <= config.risk.warningPercent) {
    level = "warning";
  }

  // Per-position liquidation distance risk — escalate if any position is worse
  let worstPositionLevel: RiskLevel = "safe";
  for (const p of balance.positions) {
    const pLevel = positionRiskLevel(p);
    if (LEVEL_SEVERITY[pLevel] > LEVEL_SEVERITY[worstPositionLevel]) {
      worstPositionLevel = pLevel;
    }
  }
  if (LEVEL_SEVERITY[worstPositionLevel] > LEVEL_SEVERITY[level]) {
    level = worstPositionLevel;
  }

  // Build message
  const parts: string[] = [];
  if (pct <= config.risk.warningPercent) {
    const marginMessages: Record<RiskLevel, string> = {
      safe: "",
      warning: `Margin free at ${pct.toFixed(1)}% — approaching risk zone`,
      danger: `Margin free at ${pct.toFixed(1)}% — liquidation risk!`,
      critical: `MARGIN FREE ${pct.toFixed(1)}% — LIQUIDATION IMMINENT!`,
    };
    const marginLevel: RiskLevel = pct <= config.risk.criticalPercent ? "critical"
      : pct <= config.risk.dangerPercent ? "danger"
      : "warning";
    parts.push(marginMessages[marginLevel]);
  }

  // Position-level warnings
  const riskyPositions = balance.positions
    .filter((p) => LEVEL_SEVERITY[positionRiskLevel(p)] >= LEVEL_SEVERITY.warning)
    .sort((a, b) =>
      LEVEL_SEVERITY[positionRiskLevel(b)] - LEVEL_SEVERITY[positionRiskLevel(a)]
    );
  for (const p of riskyPositions) {
    const pLevel = positionRiskLevel(p);
    const dist = p.liquidationDistancePercent!.toFixed(1);
    if (pLevel === "critical") {
      parts.push(`${p.market}: liq ${dist}% away — IMMINENT!`);
    } else if (pLevel === "danger") {
      parts.push(`${p.market}: liq ${dist}% away — danger`);
    } else {
      parts.push(`${p.market}: liq ${dist}% away — warning`);
    }
  }

  // Position details
  const positionLines = balance.positions.map(formatPositionLine).join("\n");

  return {
    exchange: balance.exchange,
    level,
    marginFreePercent: pct,
    message: parts.join("\n"),
    details: level !== "safe" && positionLines ? `Positions:\n${positionLines}` : undefined,
  };
}

export function analyzeAll(balances: ExchangeBalance[]): RiskAssessment[] {
  return balances.map(analyzeRisk);
}
