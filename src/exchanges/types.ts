export interface Position {
  market: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice?: number;
  unrealizedPnl: number;
  liquidationPrice?: number;
  margin?: number;
  leverage?: number;
}

export interface ExchangeBalance {
  exchange: string;
  timestamp: string;
  totalUsd: number;
  balance: number;
  marginUsed: number;
  marginFreePercent: number;
  positionCount: number;
  unrealizedPnl: number;
  positions: Position[];
  raw?: Record<string, unknown>;
}

export type RiskLevel = "safe" | "warning" | "danger" | "critical";

export interface RiskAssessment {
  exchange: string;
  level: RiskLevel;
  marginFreePercent: number;
  message: string;
  details?: string;
}

export interface ExchangeFetcher {
  name: string;
  enabled: boolean;
  fetchBalance(): Promise<ExchangeBalance>;
}
