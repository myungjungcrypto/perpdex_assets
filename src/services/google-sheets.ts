import { google, sheets_v4 } from "googleapis";
import { config } from "../config.js";
import { ExchangeBalance } from "../exchanges/types.js";
import { logger } from "../utils/logger.js";

let sheetsClient: sheets_v4.Sheets | null = null;

function getClient(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;

  if (!config.google.serviceAccountJson || !config.google.spreadsheetId) {
    throw new Error("Google Sheets not configured");
  }

  const credentials = JSON.parse(config.google.serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

// Fixed row assignments for each exchange in Balance Log.
// Row 1 = headers, Row 2 = Paradex, Row 3 = Lighter, etc.
// This allows other sheets to reference fixed cells like ='Balance Log'!C2
const EXCHANGE_ROW: Record<string, number> = {
  Paradex: 2,
  Lighter: 3,
  Extended: 4,
  Pacifica: 5,
  "Pacifica-1": 5,
  Nado: 6,
  "Nado-1": 6,
  "01Exchange": 7,
  Variational: 8,
  // Multi-address overflow rows
  "Pacifica-2": 9,
  "Pacifica-3": 10,
  "Nado-2": 11,
  "Nado-3": 12,
  Hyperliquid: 13,
  "Hyperliquid-1": 13,
  "Hyperliquid-2": 14,
  "Hyperliquid-3": 15,
};

export async function updateBalanceLog(
  balances: ExchangeBalance[]
): Promise<void> {
  if (!config.google.enabled) return;
  const sheets = getClient();
  const sheetName = config.google.balanceLogSheet;

  const requests = balances.map((b) => {
    const row = EXCHANGE_ROW[b.exchange];
    if (!row) {
      logger.warn(`Balance Log: unknown exchange "${b.exchange}", skipping`);
      return null;
    }
    return sheets.spreadsheets.values.update({
      spreadsheetId: config.google.spreadsheetId,
      range: `${sheetName}!A${row}:H${row}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          b.timestamp,
          b.exchange,
          b.totalUsd.toFixed(2),
          b.balance.toFixed(2),
          b.marginUsed.toFixed(2),
          `${b.marginFreePercent.toFixed(1)}%`,
          b.positionCount,
          b.unrealizedPnl.toFixed(2),
        ]],
      },
    });
  }).filter(Boolean);

  try {
    await Promise.all(requests);
    logger.info(`Updated ${requests.length} rows in Balance Log (overwrite)`);
  } catch (err) {
    logger.error("Failed to update Balance Log", err);
    throw err;
  }
}

export async function appendSummary(
  balances: ExchangeBalance[],
  alertExchanges: string[]
): Promise<void> {
  if (!config.google.enabled) return;
  const sheets = getClient();
  const now = balances[0]?.timestamp ?? new Date().toISOString();
  const totalAll = balances.reduce((sum, b) => sum + b.totalUsd, 0);

  // Map balance names: "Pacifica-1" → "Pacifica" column, "Nado-1" → "Nado" column
  const exchangeMap: Record<string, string> = {};
  for (const b of balances) {
    const key = b.exchange.replace(/-1$/, "");
    exchangeMap[key] = b.totalUsd.toFixed(0);
  }

  const exchangeOrder = [
    "Paradex",
    "Lighter",
    "Extended",
    "Pacifica",
    "Nado",
    "01Exchange",
    "Variational",
    "Pacifica-2",
    "Pacifica-3",
    "Nado-2",
    "Nado-3",
    "Hyperliquid",
    "Hyperliquid-2",
    "Hyperliquid-3",
  ];

  const row = [
    now,
    totalAll.toFixed(2),
    ...exchangeOrder.map((name) => exchangeMap[name] ?? "-"),
    alertExchanges.length > 0 ? alertExchanges.join(", ") : "none",
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.google.spreadsheetId,
      range: `${config.google.summarySheet}!A:R`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
    logger.info("Wrote summary row");
  } catch (err) {
    logger.error("Failed to write Summary", err);
    throw err;
  }
}

export async function ensureSheetHeaders(): Promise<void> {
  if (!config.google.enabled) {
    logger.info("Google Sheets not configured — skipping");
    return;
  }
  const sheets = getClient();
  const spreadsheetId = config.google.spreadsheetId;

  const balanceHeaders = [
    [
      "Timestamp",
      "Exchange",
      "Total (USD)",
      "Balance",
      "Margin Used",
      "Margin Free %",
      "Positions",
      "Unrealized PnL",
    ],
  ];

  const summaryHeaders = [
    [
      "Timestamp",
      "Total All (USD)",
      "Paradex",
      "Lighter",
      "Extended",
      "Pacifica",
      "Nado",
      "01Exchange",
      "Variational",
      "Pacifica-2",
      "Pacifica-3",
      "Nado-2",
      "Nado-3",
      "Hyperliquid",
      "Hyperliquid-2",
      "Hyperliquid-3",
      "Alert",
    ],
  ];

  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const existing = meta.data.sheets?.map((s) => s.properties?.title) ?? [];

    const toCreate: string[] = [];
    if (!existing.includes(config.google.balanceLogSheet))
      toCreate.push(config.google.balanceLogSheet);
    if (!existing.includes(config.google.summarySheet))
      toCreate.push(config.google.summarySheet);

    if (toCreate.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: toCreate.map((title) => ({
            addSheet: { properties: { title } },
          })),
        },
      });
      logger.info(`Created sheets: ${toCreate.join(", ")}`);
    }

    // Write headers if sheets are empty
    const balanceCheck = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${config.google.balanceLogSheet}!A1`,
    });
    if (!balanceCheck.data.values?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${config.google.balanceLogSheet}!A1:H1`,
        valueInputOption: "RAW",
        requestBody: { values: balanceHeaders },
      });
    }

    const summaryCheck = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${config.google.summarySheet}!A1`,
    });
    if (!summaryCheck.data.values?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${config.google.summarySheet}!A1:Q1`,
        valueInputOption: "RAW",
        requestBody: { values: summaryHeaders },
      });
    }

    logger.info("Sheet headers ensured");
  } catch (err) {
    logger.error("Failed to ensure sheet headers", err);
    throw err;
  }
}
