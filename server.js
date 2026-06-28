const express = require('express');
const crypto = require('crypto');
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

// Token store: token -> { user, expiresAt }
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const tokens = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function validateToken(token) {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokens.delete(token);
    return null;
  }
  return entry.user;
}

// ---- Middleware ----

app.use(express.json());

// ---- Public routes (no auth required) ----

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === DEFAULT_USER && password === DEFAULT_PASS) {
    const token = generateToken();
    tokens.set(token, {
      user: username,
      expiresAt: Date.now() + TOKEN_TTL
    });
    log.info(`User "${username}" logged in, token expires in 30 days`);
    return res.json({ ok: true, token, expiresIn: TOKEN_TTL / 1000 });
  }
  log.warn(`Failed login attempt for "${username}"`);
  res.status(401).json({ error: '用户名或密码错误' });
});

app.post('/api/logout', (req, res) => {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const token = auth.slice(7);
    if (tokens.has(token)) {
      log.info('Token revoked');
      tokens.delete(token);
    }
  }
  res.json({ ok: true });
});

// ---- Auth middleware ----

app.use((req, res, next) => {
  // Allow static assets and login without auth
  if (req.path.endsWith('.css') || req.path.endsWith('.js') || req.path === '/login.html' || req.path === '/api/login') {
    return next();
  }

  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const user = token ? validateToken(token) : null;

  if (!user) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: '未登录或 token 已过期' });
    }
    return res.redirect('/login.html');
  }
  next();
});

// ---- Static files ----
app.use(express.static(path.join(__dirname, 'public')));

// Redirect root to index.html
app.get('/', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.redirect('/login.html');
  const user = validateToken(auth.slice(7));
  if (!user) return res.redirect('/login.html');
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
