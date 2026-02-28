import dotenv from "dotenv";
dotenv.config();

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

export const config = {
  // Google Sheets
  google: {
    serviceAccountJson: env("GOOGLE_SERVICE_ACCOUNT_JSON"),
    spreadsheetId: env("GOOGLE_SPREADSHEET_ID"),
    balanceLogSheet: env("GOOGLE_BALANCE_LOG_SHEET", "Balance Log"),
    summarySheet: env("GOOGLE_SUMMARY_SHEET", "Summary"),
  },

  // Telegram
  telegram: {
    botToken: env("TELEGRAM_BOT_TOKEN"),
    chatId: env("TELEGRAM_CHAT_ID"),
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
    baseUrl: env("EXTENDED_BASE_URL", "https://api.extended.exchange"),
  },

  // Pacifica
  pacifica: {
    walletAddress: optEnv("PACIFICA_WALLET_ADDRESS"),
    baseUrl: env("PACIFICA_BASE_URL", "https://api.pacifica.fi"),
  },

  // Nado
  nado: {
    walletAddress: optEnv("NADO_WALLET_ADDRESS"),
    linkedSignerKey: optEnv("NADO_LINKED_SIGNER_KEY"),
    gatewayUrl: env("NADO_GATEWAY_URL", "https://gateway.prod.nado.xyz/v1"),
  },

  // 01 Exchange
  o1: {
    solanaKeypair: optEnv("O1_SOLANA_KEYPAIR"),
    baseUrl: env("O1_BASE_URL", "http://localhost:3000"),
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

  // Risk thresholds
  risk: {
    warningPercent: Number(env("RISK_WARNING_PERCENT", "20")),
    dangerPercent: Number(env("RISK_DANGER_PERCENT", "10")),
    criticalPercent: Number(env("RISK_CRITICAL_PERCENT", "5")),
    alertCooldownMinutes: Number(env("ALERT_COOLDOWN_MINUTES", "30")),
  },
};
