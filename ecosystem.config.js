module.exports = {
  apps: [
    {
      name: 'build-tool',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      // Log configuration
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      // Restart on failure
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // Process limits
      max_memory_restart: '500M',
      // Graceful shutdown
      kill_timeout: 10000,
      wait_ready: false
    }
  ]
};
