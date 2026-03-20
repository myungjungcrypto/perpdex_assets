import dotenv from "dotenv";
dotenv.config({ path: process.env.ENV_FILE || ".env" });

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) {
    throw new Error(`Missing env var: ${key}`);
  }
  return val;
}

function optEnv(key: string): string | undefined {
  return process.env[key];
}

function boolEnv(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(val.toLowerCase());
}

export const config = {
  // Google Sheets (optional — omit credentials to disable)
  google: {
    serviceAccountJson: optEnv("GOOGLE_SERVICE_ACCOUNT_JSON"),
    spreadsheetId: optEnv("GOOGLE_SPREADSHEET_ID"),
    get enabled(): boolean {
      return !!this.serviceAccountJson && !!this.spreadsheetId;
    },
    balanceLogSheet: env("GOOGLE_BALANCE_LOG_SHEET", "Balance Log"),
    summarySheet: env("GOOGLE_SUMMARY_SHEET", "Summary"),
  },

  // Telegram
  telegram: {
    botToken: env("TELEGRAM_BOT_TOKEN"),
    chatId: env("TELEGRAM_CHAT_ID"),
    commandPollIntervalMs: Number(env("TELEGRAM_COMMAND_POLL_INTERVAL_MS", "5000")),
    enableCommands: boolEnv("TELEGRAM_ENABLE_COMMANDS", false),
  },

  // Paradex
  paradex: {
    jwtToken: optEnv("PARADEX_JWT_TOKEN"),
    baseUrl: env("PARADEX_BASE_URL", "https://api.prod.paradex.trade/v1"),
  },

  // Lighter
  lighter: {
    roToken: optEnv("LIGHTER_RO_TOKEN"),
    baseUrl: env("LIGHTER_BASE_URL", "https://mainnet.zklighter.elliot.ai"),
  },

  // Extended
  extended: {
    apiKey: optEnv("EXTENDED_API_KEY"),
    baseUrl: env("EXTENDED_BASE_URL", "https://api.starknet.extended.exchange/api/v1"),
  },

  // Pacifica (supports comma-separated addresses: addr1,addr2)
  pacifica: {
    walletAddresses: (optEnv("PACIFICA_WALLET_ADDRESS") ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean),
    baseUrl: env("PACIFICA_BASE_URL", "https://api.pacifica.fi"),
  },

  // Nado
  nado: {
    walletAddresses: (optEnv("NADO_WALLET_ADDRESS") ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean),
    get walletAddress(): string | undefined {
      return this.walletAddresses[0];
    },
    linkedSignerKey: optEnv("NADO_LINKED_SIGNER_KEY"),
    gatewayUrl: env("NADO_GATEWAY_URL", "https://gateway.prod.nado.xyz/v1"),
  },

  // 01 Exchange (N1 / Nord)
  o1: {
    walletAddress: optEnv("O1_WALLET_ADDRESS"),
    webServerUrl: env("O1_WEB_SERVER_URL", "https://zo-mainnet.n1.xyz"),
    appKey: env("O1_APP_KEY", "zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5"),
    solanaRpcUrl: env("O1_SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),
  },

  // Variational
  variational: {
    apiKey: optEnv("VARIATIONAL_API_KEY"),
    apiSecret: optEnv("VARIATIONAL_API_SECRET"),
    baseUrl: env(
      "VARIATIONAL_BASE_URL",
      "https://omni-client-api.prod.ap-northeast-1.variational.io"
    ),
  },

  // Hyperliquid (supports comma-separated addresses: addr1,addr2)
  hyperliquid: {
    walletAddresses: (optEnv("HYPERLIQUID_WALLET_ADDRESS") ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean),
    baseUrl: env("HYPERLIQUID_BASE_URL", "https://api.hyperliquid.xyz"),
    hip3Dexes: (optEnv("HYPERLIQUID_HIP3_DEXES") ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean),
  },

  // Risk thresholds
  risk: {
    warningPercent: Number(env("RISK_WARNING_PERCENT", "20")),
    dangerPercent: Number(env("RISK_DANGER_PERCENT", "10")),
    criticalPercent: Number(env("RISK_CRITICAL_PERCENT", "5")),
    // Per-position liquidation distance thresholds (%)
    positionWarningDistance: Number(env("POSITION_WARNING_DISTANCE", "30")),
    positionDangerDistance: Number(env("POSITION_DANGER_DISTANCE", "15")),
    positionCriticalDistance: Number(env("POSITION_CRITICAL_DISTANCE", "7")),
    alertCooldownMinutes: Number(env("ALERT_COOLDOWN_MINUTES", "30")),
  },
};
