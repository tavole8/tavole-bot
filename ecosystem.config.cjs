// PM2 Ecosystem Configuration for Tavole Bot
// Usage: pm2 start ecosystem.config.cjs
// Docs: https://pm2.keymetrics.io/docs/usage/application-declaration/

module.exports = {
  apps: [
    {
      name: 'tavole-bot',
      script: 'index.js',
      cwd: __dirname,

      // Auto-restart on crash
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,

      // Watch for file changes (dev convenience)
      watch: true,
      ignore_watch: ['node_modules', 'data', 'logs', '*.log', '.git'],

      // Memory limit — restart if exceeds 512MB
      max_memory_restart: '512M',

      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/tmp/tavole-bot-error.log',
      out_file: '/tmp/tavole-bot.log',
      merge_logs: true,

      // Environment
      env: {
        NODE_ENV: 'production',
      },

      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 10000,
    },
  ],
};
