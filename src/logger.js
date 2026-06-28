const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'data', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

// ANSI color codes for console output
const COLORS = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', white: '\x1b[37m' };

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_COLORS = { debug: 'dim', info: 'green', warn: 'yellow', error: 'red' };
const LEVEL_NAMES = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };

// Minimum level for console output (default: debug in dev, info in production)
let consoleLevel = process.env.LOG_LEVEL ? LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info : LEVELS.info;
// File always gets everything (debug and above)
const fileLevel = LEVELS.debug;

let logStream = null;

function getLogFile() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(LOG_DIR, `server-${date}.log`);
}

function ensureStream() {
  const file = getLogFile();
  if (!logStream || logStream.path !== file) {
    if (logStream) { try { logStream.end(); } catch {} }
    logStream = fs.createWriteStream(file, { flags: 'a' });
  }
}

function formatTime() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.` +
    `${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function log(level, module, message, extra) {
  ensureStream();
  const time = formatTime();
  const levelName = LEVEL_NAMES[level];

  // Console output (with colors)
  if (LEVELS[level] >= consoleLevel) {
    const color = COLORS[LEVEL_COLORS[level]] || COLORS.reset;
    const modTag = module ? `${COLORS.cyan}[${module}]${COLORS.reset} ` : '';
    const extraStr = extra ? ` ${COLORS.dim}${JSON.stringify(extra)}${COLORS.reset}` : '';
    process.stdout.write(`${color}${levelName}${COLORS.reset} ${COLORS.dim}${time}${COLORS.reset} ${modTag}${message}${extraStr}\n`);
  }

  // File output (plain text, always)
  const modTag = module ? `[${module}] ` : '';
  const extraStr = extra ? ` ${JSON.stringify(extra)}` : '';
  logStream.write(`${levelName} ${time} ${modTag}${message}${extraStr}\n`);
}

function createLogger(module) {
  return {
    debug(msg, extra) { log('debug', module, msg, extra); },
    info(msg, extra)  { log('info', module, msg, extra); },
    warn(msg, extra)  { log('warn', module, msg, extra); },
    error(msg, extra) { log('error', module, msg, extra); },
  };
}

// Set console log level
function setLevel(level) {
  if (LEVELS[level] !== undefined) {
    consoleLevel = LEVELS[level];
  }
}

// Close the log stream (call on shutdown)
function close() {
  if (logStream) {
    try { logStream.end(); } catch {}
    logStream = null;
  }
}

module.exports = { createLogger, setLevel, close };
