import { google, sheets_v4 } from "googleapis";
import { config } from "../config";
import { ExchangeBalance } from "../exchanges/types";
import { logger } from "../utils/logger";

let sheetsClient: sheets_v4.Sheets | null = null;

function getClient(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;

  const credentials = JSON.parse(config.google.serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

export async function appendBalanceLog(
  balances: ExchangeBalance[]
): Promise<void> {
  const sheets = getClient();
  const rows = balances.map((b) => [
    b.timestamp,
    b.exchange,
    b.totalUsd.toFixed(2),
    b.balance.toFixed(2),
    b.marginUsed.toFixed(2),
    `${b.marginFreePercent.toFixed(1)}%`,
    b.positionCount,
    b.unrealizedPnl.toFixed(2),
  ]);

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.google.spreadsheetId,
      range: `${config.google.balanceLogSheet}!A:H`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });
    logger.info(`Wrote ${rows.length} rows to Balance Log`);
  } catch (err) {
    logger.error("Failed to write Balance Log", err);
    throw err;
  }
}

export async function appendSummary(
  balances: ExchangeBalance[],
  alertExchanges: string[]
): Promise<void> {
  const sheets = getClient();
  const now = balances[0]?.timestamp ?? new Date().toISOString();
  const totalAll = balances.reduce((sum, b) => sum + b.totalUsd, 0);

  const exchangeMap: Record<string, string> = {};
  for (const b of balances) {
    exchangeMap[b.exchange] = b.totalUsd.toFixed(0);
  }

  const exchangeOrder = [
    "Paradex",
    "Lighter",
    "Extended",
    "Pacifica",
    "Nado",
    "01Exchange",
    "Variational",
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
      range: `${config.google.summarySheet}!A:J`,
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
        range: `${config.google.summarySheet}!A1:J1`,
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
