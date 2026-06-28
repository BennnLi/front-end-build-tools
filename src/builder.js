const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const db = require('./db');
const git = require('./git');
const syslog = require('./logger').createLogger('builder');

const ARTIFACTS_DIR = path.join(__dirname, '..', 'data', 'artifacts');
const WORK_DIR = path.join(__dirname, '..', 'data', 'work');
const LOGS_DIR = path.join(__dirname, '..', 'data', 'logs');

// Per-repo queue: max 3 concurrent tasks
const repoQueues = new Map(); // repoId -> { running: number, queue: [] }

const MAX_CONCURRENT = 3;

fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
fs.mkdirSync(WORK_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });

function getQueue(repoId) {
  if (!repoQueues.has(repoId)) {
    repoQueues.set(repoId, { running: 0, queue: [] });
  }
  return repoQueues.get(repoId);
}

function enqueue(repoId, taskId) {
  const q = getQueue(repoId);
  q.queue.push(taskId);
  syslog.info(`Task #${taskId} enqueued (running=${q.running}, waiting=${q.queue.length})`);
  processQueue(repoId);
}

function processQueue(repoId) {
  const q = getQueue(repoId);
  while (q.running < MAX_CONCURRENT && q.queue.length > 0) {
    const taskId = q.queue.shift();
    q.running++;
    runBuild(repoId, taskId).finally(() => {
      q.running--;
      processQueue(repoId);
    });
  }
}

async function runBuild(repoId, taskId) {
  const task = db.getTask(taskId);
  if (!task) return;

  const repo = db.getRepo(repoId);
  if (!repo) return;

  const logFile = path.join(LOGS_DIR, `${taskId}.log`);
  const workDir = path.join(WORK_DIR, `${repoId}-${taskId}`);

  db.updateTask(taskId, {
    status: 'running',
    logFile,
    startedAt: new Date().toISOString()
  });

  syslog.info(`Task #${taskId} started: ${repo.name} / ${task.branch}`);

  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logStream.write(line);
  }

    // Get stored credentials if any
    const creds = db.getRepoCredentials(repoId);

    try {
    log(`Starting build for ${repo.name} on branch ${task.branch}`);

    // Step 1: Fetch latest (with credentials if stored)
    log('Fetching repository...');
    await git.cloneOrFetch(repo.url, repoId, creds);

    // Step 2: Get latest commits
    log('Getting latest commits...');
    const commits = await git.getLatestCommits(repoId, task.branch, 5);
    db.updateTask(taskId, { commits });

    // Step 3: Checkout branch to work directory
    log(`Checking out branch ${task.branch}...`);
    // Clean work dir
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    await git.checkoutBranch(repoId, task.branch, workDir, creds);

    // Step 4: Run build script
    const buildCwd = repo.buildCwd ? path.join(workDir, repo.buildCwd) : workDir;

    let scriptCmd;
    if (repo.scriptType === 'file' && repo.scriptFile && fs.existsSync(repo.scriptFile)) {
      // Copy script file to work directory with a fixed name
      const ext = path.extname(repo.scriptFile) || '.sh';
      const scriptName = `_build_script${ext}`;
      const destScript = path.join(workDir, scriptName);
      fs.copyFileSync(repo.scriptFile, destScript);
      log(`Running script file: ${path.basename(repo.scriptFile)}`);

      const isWindows = process.platform === 'win32';
      // Use forward slashes for cross-platform paths in shell commands
      const safePath = destScript.replace(/\\/g, '/');
      if (isWindows) {
        if (ext === '.ps1') {
          scriptCmd = `powershell -ExecutionPolicy Bypass -File "${destScript}"`;
        } else if (ext === '.sh') {
          scriptCmd = `bash "${safePath}"`;
        } else if (ext === '.bat' || ext === '.cmd') {
          // Direct path (spawn handles it), no extra quotes needed
          scriptCmd = destScript;
        } else {
          scriptCmd = destScript;
        }
      } else {
        scriptCmd = `bash "${destScript}"`;
      }
    } else {
      log(`Running build script: ${repo.buildScript}`);
      scriptCmd = joinScriptLines(repo.buildScript);
    }

    syslog.debug(`Task #${taskId} executing script`, { cwd: buildCwd, type: repo.scriptType || 'inline' });
    const exitCode = await runScript(scriptCmd, buildCwd, logStream);

    if (exitCode !== 0) {
      throw new Error(`Build script exited with code ${exitCode}`);
    }

    // Step 5: Create zip artifact
    const packSource = repo.packDir ? path.join(buildCwd, repo.packDir) : buildCwd;

    // Verify pack directory exists
    if (repo.packDir && !fs.existsSync(packSource)) {
      log(`WARNING: pack directory "${repo.packDir}" not found, packaging entire build directory`);
      log(`Expected path: ${packSource}`);
    }

    const actualPack = (repo.packDir && fs.existsSync(packSource)) ? packSource : buildCwd;
    log(`Creating artifact archive from: ${repo.packDir || '(root)'}`);
    const artifactPath = path.join(ARTIFACTS_DIR, `${repo.name}-${task.branch}-${taskId}.zip`);
    await createZip(actualPack, artifactPath);

    const stats = fs.statSync(artifactPath);
    log(`Artifact created: ${artifactPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
    log('Build completed successfully!');

    db.updateTask(taskId, {
      status: 'success',
      artifactPath,
      finishedAt: new Date().toISOString()
    });
    syslog.info(`Task #${taskId} completed successfully`, { artifact: path.basename(artifactPath), size: `${(stats.size / 1024 / 1024).toFixed(2)}MB` });

  } catch (err) {
    log(`Build failed: ${err.message}`);
    db.updateTask(taskId, {
      status: 'failed',
      finishedAt: new Date().toISOString()
    });
    // Mark repo as auth error so user can fix credentials
    if (err.isAuthError) {
      syslog.warn(`Task #${taskId} failed: auth error for ${repo.name}`);
      db.markRepoAuthError(repoId);
    } else {
      syslog.error(`Task #${taskId} failed: ${err.message}`, { repo: repo.name, branch: task.branch });
    }
  } finally {
    logStream.end();
    // Clean work directory
    if (fs.existsSync(workDir)) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * Join multi-line inline scripts with && so any command failure propagates.
 * Lines that already contain && or || are wrapped in parentheses to preserve precedence.
 * Single-line scripts are returned as-is.
 */
function joinScriptLines(script) {
  if (!script || !script.includes('\n')) return script;

  const lines = script
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('REM ') && !l.startsWith('@REM '));

  if (lines.length <= 1) return lines[0] || script;

  return lines
    .map(line => {
      // If the line has shell operators (&& or ||), wrap it to preserve precedence
      if (/\|\||&&/.test(line)) {
        return `(${line})`;
      }
      return line;
    })
    .join(' && ');
}

function runScript(script, cwd, logStream) {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/c', script] : ['-c', script];

    const child = spawn(shell, shellArgs, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (data) => {
      logStream.write(data);
    });

    child.stderr.on('data', (data) => {
      logStream.write(data);
    });

    child.on('close', (code) => {
      resolve(code ?? 1);
    });

    child.on('error', (err) => {
      logStream.write(`Process error: ${err.message}\n`);
      resolve(1);
    });
  });
}

function createZip(sourceDir, outputPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// Get current running count for a repo
function getRunningCount(repoId) {
  const q = repoQueues.get(repoId);
  return q ? q.running : 0;
}

// Get waiting count for a repo
function getWaitingCount(repoId) {
  const q = repoQueues.get(repoId);
  return q ? q.queue.length : 0;
}

// Restore in-progress tasks on startup (mark them as failed since they were interrupted)
function recoverTasks() {
  const tasks = db.getTasks();
  let recovered = 0;
  for (const task of tasks) {
    if (task.status === 'running' || task.status === 'waiting') {
      // Append a note to the log file so users can see it was interrupted
      if (task.logFile) {
        try {
          fs.appendFileSync(task.logFile, `\n[${new Date().toISOString()}] ⚠ Task #${task.repoTaskNum || task.id} was interrupted (server restart). Marked as failed.\n`);
        } catch {}
      }
      db.updateTask(task.id, {
        status: 'failed',
        finishedAt: new Date().toISOString()
      });
      recovered++;
    }
  }
  if (recovered > 0) {
    syslog.warn(`Recovered ${recovered} interrupted task(s) — marked as failed`);
  }
}

module.exports = {
  enqueue,
  getRunningCount,
  getWaitingCount,
  recoverTasks,
  ARTIFACTS_DIR,
  LOGS_DIR
};
