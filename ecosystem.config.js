const fs = require("fs");
const path = require("path");

const usersDir = path.join(__dirname, "users");
const apps = [];

// Scan users/ directory — one PM2 app per user folder with .env
if (fs.existsSync(usersDir)) {
  for (const name of fs.readdirSync(usersDir)) {
    const envFile = path.join(usersDir, name, ".env");
    if (fs.statSync(path.join(usersDir, name)).isDirectory() && fs.existsSync(envFile)) {
      apps.push({
        name: `monitor-${name}`,
        script: "dist/index.js",
        autorestart: true,
        restart_delay: 5000,
        watch: false,
        env: {
          NODE_ENV: "production",
          ENV_FILE: envFile,
        },
        error_file: `logs/${name}-error.log`,
        out_file: `logs/${name}-out.log`,
        log_date_format: "YYYY-MM-DD HH:mm:ss",
        max_memory_restart: "200M",
      });
    }
  }
}

// Fallback: single instance using root .env
if (apps.length === 0) {
  apps.push({
    name: "balance-monitor",
    script: "dist/index.js",
    autorestart: true,
    restart_delay: 5000,
    watch: false,
    env: { NODE_ENV: "production" },
    error_file: "logs/error.log",
    out_file: "logs/out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    max_memory_restart: "200M",
  });
}

module.exports = { apps };
