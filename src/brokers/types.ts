// Korean brokerage (증권사) fetcher interfaces.
// Separate from ExchangeFetcher: KRW-denominated, no margin/liquidation concept,
// and polled on a slower cadence than perp DEXes.

export interface BrokerHolding {
  code: string;
  name: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  evalAmount: number;
  profitLoss: number;
  profitRatePercent: number;
}

export interface BrokerBalance {
  broker: string;
  timestamp: string;
  /** 추정예탁자산 — total account value including cash (KRW) */
  totalKrw: number;
  /** 총평가금액 — market value of held stocks (KRW) */
  stockValueKrw: number;
  /** 총평가손익 (KRW) */
  profitLossKrw: number;
  /** 총수익률 (%) */
  profitRatePercent: number;
  /** 총대출금 + 총융자금액 (KRW) */
  loanKrw: number;
  holdings: BrokerHolding[];
  raw: Record<string, unknown>;
}

export interface BrokerFetcher {
  name: string;
  enabled: boolean;
  fetchBalance(): Promise<BrokerBalance>;
}
