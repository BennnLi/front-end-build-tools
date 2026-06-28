const express = require('express');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const builder = require('./src/builder');
const cleaner = require('./src/cleaner');
const routes = require('./src/routes');
const logger = require('./src/logger');

const log = logger.createLogger('server');
const app = express();
const PORT = process.env.PORT || 3000;

// User accounts: username -> { password, role }
const USERS = {
  admin: { password: process.env.ADMIN_PASS || 'admin', role: 'admin' },
  user:  { password: process.env.USER_PASS  || 'user',  role: 'user' }
};

// Token store: token -> { user, role, expiresAt }
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
  return { user: entry.user, role: entry.role };
}

// ---- Middleware ----

app.use(express.json());

// ---- Public routes ----

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const account = USERS[username];
  if (account && account.password === password) {
    const token = generateToken();
    tokens.set(token, {
      user: username,
      role: account.role,
      expiresAt: Date.now() + TOKEN_TTL
    });
    log.info(`User "${username}" (${account.role}) logged in, token expires in 30 days`);
    return res.json({ ok: true, token, role: account.role, expiresIn: TOKEN_TTL / 1000 });
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

// ---- Auth middleware (API only) ----

app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next();

  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const session = token ? validateToken(token) : null;

  if (!session) {
    return res.status(401).json({ error: '未登录或 token 已过期' });
  }
  req.user = session.user;
  req.role = session.role;
  next();
});

// ---- Static files ----
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
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

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (127.0.0.1) and non-IPv4
      if (!iface.internal && iface.family === 'IPv4') {
        return iface.address;
      }
    }
  }
  return null;
}

app.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  log.info(`Build tool started`);
  log.info(`  Local:   http://localhost:${PORT}`);
  if (lanIp) log.info(`  Network: http://${lanIp}:${PORT}`);
  log.info(`  Environment: ${process.platform}, Node: ${process.version}`);
});
