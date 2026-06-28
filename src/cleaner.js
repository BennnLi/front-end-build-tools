const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const log = require('./logger').createLogger('cleaner');

// Clean artifacts and logs daily at 3:00 AM
function startCleaner() {
  cron.schedule('0 3 * * *', () => {
    log.info('Starting daily cleanup...');
    cleanup();
  });
  log.info('Scheduled daily cleanup at 3:00 AM');
}

function cleanup() {
  const tasks = db.getTasks();
  let cleaned = 0;

  for (const task of tasks) {
    if (task.artifactPath && fs.existsSync(task.artifactPath)) {
      try {
        fs.unlinkSync(task.artifactPath);
        cleaned++;
      } catch (e) {
        log.error(`Failed to delete artifact: ${task.artifactPath}`, { error: e.message });
      }
    }

    if (task.logFile && fs.existsSync(task.logFile)) {
      try {
        fs.unlinkSync(task.logFile);
      } catch (e) {
        log.error(`Failed to delete log: ${task.logFile}`, { error: e.message });
      }
    }
  }

  // Clean orphaned script files
  const scriptsDir = path.join(__dirname, '..', 'data', 'scripts');
  const repos = db.getRepos();
  const validFiles = new Set(repos.filter(r => r.scriptFile).map(r => r.scriptFile));
  let orphanScripts = 0;
  if (fs.existsSync(scriptsDir)) {
    const files = fs.readdirSync(scriptsDir);
    for (const f of files) {
      const fullPath = path.join(scriptsDir, f);
      if (!validFiles.has(fullPath)) {
        try { fs.unlinkSync(fullPath); orphanScripts++; } catch {}
      }
    }
  }

  // Clear tasks from DB
  const data = { repos: db.getRepos(), tasks: [], nextTaskId: 1 };
  const dbPath = path.join(__dirname, '..', 'data', 'db.json');
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2), 'utf-8');

  log.info(`Cleanup complete: removed ${cleaned} artifacts, ${orphanScripts} orphan scripts`);
}

module.exports = { startCleaner, cleanup };
