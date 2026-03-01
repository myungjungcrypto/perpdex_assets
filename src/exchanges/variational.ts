import { ExchangeBalance, ExchangeFetcher } from "./types.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// Variational API is not yet publicly available.
// This placeholder will be updated once the API is released.
// In the meantime, on-chain queries via Arbitrum could be attempted.

export class VariationalFetcher implements ExchangeFetcher {
  name = "Variational";
  enabled = false;

  constructor() {
    if (config.variational.apiKey) {
      this.enabled = true;
      logger.info("Variational: API key found, will attempt connection");
    } else {
      logger.warn("Variational: API not yet available — skipping");
    }
  }

  async fetchBalance(): Promise<ExchangeBalance> {
    if (!this.enabled) {
      throw new Error("Variational API not yet available");
    }

    // TODO: Implement when API becomes available
    // Expected endpoints:
    //   GET /v1/portfolio/assets
    //   GET /v1/portfolio/positions
    //   GET /v1/portfolio/summary
    throw new Error("Variational API integration not yet implemented");
  }
}
