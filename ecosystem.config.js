module.exports = {
  apps: [
    {
      name: '4am-bot',
      script: 'src/bot.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: '4am-updater',
      script: 'scripts/auto-updater.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '250M',
      env: {
        NODE_ENV: 'production',
        UPDATE_INTERVAL_MS: 20000
      }
    }
  ]
};
