const timestamp = () => new Date().toISOString();

export const logger = {
  debug: (msg: string, data?: unknown) => {
    if (process.env.LOG_LEVEL === "debug") {
      console.log(`[${timestamp()}] DEBUG ${msg}`, data ?? "");
    }
  },
  info: (msg: string, data?: unknown) => {
    console.log(`[${timestamp()}] INFO  ${msg}`, data ?? "");
  },
  warn: (msg: string, data?: unknown) => {
    console.warn(`[${timestamp()}] WARN  ${msg}`, data ?? "");
  },
  error: (msg: string, data?: unknown) => {
    console.error(`[${timestamp()}] ERROR ${msg}`, data ?? "");
  },
};
