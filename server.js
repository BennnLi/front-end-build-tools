const express = require('express');
const path = require('path');
const builder = require('./src/builder');
const cleaner = require('./src/cleaner');
const routes = require('./src/routes');
const logger = require('./src/logger');

const log = logger.createLogger('server');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use(routes);

// Recover interrupted tasks
builder.recoverTasks();

// Start cleanup scheduler
cleaner.startCleaner();

// Graceful shutdown
process.on('SIGINT', () => {
  log.info('Server shutting down...');
  logger.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  log.info('Server shutting down...');
  logger.close();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
  logger.close();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled rejection: ${reason}`, { stack: reason?.stack });
});

app.listen(PORT, () => {
  log.info(`Build tool started on http://localhost:${PORT}`);
  log.info(`Environment: ${process.platform}, Node: ${process.version}`);
});
