module.exports = {
  apps: [
    {
      name: "balance-monitor",
      script: "dist/index.js",
      autorestart: true,
      restart_delay: 5000,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      max_memory_restart: "200M",
    },
  ],
};
