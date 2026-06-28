const express = require('express');
const session = require('express-session');
const path = require('path');
const builder = require('./src/builder');
const cleaner = require('./src/cleaner');
const routes = require('./src/routes');
const logger = require('./src/logger');

const log = logger.createLogger('server');
const app = express();
const PORT = process.env.PORT || 3000;

// Default credentials
const DEFAULT_USER = process.env.BUILD_USER || 'admin';
const DEFAULT_PASS = process.env.BUILD_PASS || 'admin';

// ---- Middleware ----

app.use(express.json());

app.use(session({
  secret: 'build-tool-session-' + (process.env.SESSION_SECRET || Math.random().toString(36)),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// ---- Public routes (no auth required) ----

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === DEFAULT_USER && password === DEFAULT_PASS) {
    req.session.user = username;
    log.info(`User "${username}" logged in`);
    return res.json({ ok: true });
  }
  log.warn(`Failed login attempt for "${username}"`);
  res.status(401).json({ error: '用户名或密码错误' });
});

app.post('/api/logout', (req, res) => {
  if (req.session.user) {
    log.info(`User "${req.session.user}" logged out`);
  }
  req.session.destroy();
  res.json({ ok: true });
});

// ---- Auth middleware ----

app.use((req, res, next) => {
  // Allow static assets without auth so login page can render
  if (req.path.endsWith('.css') || req.path.endsWith('.js') || req.path === '/login.html' || req.path === '/api/login') {
    return next();
  }

  if (!req.session.user) {
    // API requests return 401, page requests redirect to login
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: '未登录' });
    }
    return res.redirect('/login.html');
  }
  next();
});

// ---- Static files ----
app.use(express.static(path.join(__dirname, 'public')));

// Redirect root to index.html
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- API routes ----
app.use(routes);

// ---- Init ----

builder.recoverTasks();
cleaner.startCleaner();

// ---- Shutdown ----

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
