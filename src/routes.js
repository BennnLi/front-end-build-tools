const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const db = require('./db');
const git = require('./git');
const builder = require('./builder');
const log = require('./logger').createLogger('api');

const SCRIPTS_DIR = path.join(__dirname, '..', 'data', 'scripts');
fs.mkdirSync(SCRIPTS_DIR, { recursive: true });

// Multer config for script file uploads
const upload = multer({
  dest: SCRIPTS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter(req, file, cb) {
    cb(null, true); // accept any file type
  }
});

// Request logging middleware
router.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    // Skip static file requests
    if (req.path.startsWith('/api/')) {
      log.debug(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// ---- Repos ----

// List repos (strip sensitive credential fields)
router.get('/api/repos', (req, res) => {
  const repos = db.getRepos().map(r => ({
    ...r,
    authUser: r.authUser ? '***' : '', // mask username
    authPass: '',                       // never expose password
    runningCount: builder.getRunningCount(r.id),
    waitingCount: builder.getWaitingCount(r.id)
  }));
  res.json(repos);
});

// Add repo
router.post('/api/repos', async (req, res) => {
  const { name, url, buildScript, buildCwd, scriptType, scriptFile, packDir } = req.body;
  if (!name || !url) {
    return res.status(400).json({ error: 'name and url are required' });
  }
  const repo = db.addRepo({ name, url, buildScript, buildCwd, scriptType, scriptFile, packDir });
  log.info(`Repo added: ${name}`, { url });

  // Clone in background — uses host credentials by default
  git.cloneOrFetch(url, repo.id).then(() => {
    log.info(`Repo cloned successfully: ${name}`);
  }).catch(err => {
    if (err.isAuthError) {
      log.warn(`Auth error cloning ${name}: ${err.message}`);
      db.markRepoAuthError(repo.id);
    } else {
      log.error(`Failed to clone ${name}: ${err.message}`);
    }
  });

  res.json(repo);
});

// Update repo
router.put('/api/repos/:id', (req, res) => {
  const repo = db.updateRepo(req.params.id, req.body);
  if (!repo) return res.status(404).json({ error: 'Repo not found' });
  res.json(repo);
});

// Delete repo
router.delete('/api/repos/:id', (req, res) => {
  const repo = db.getRepo(req.params.id);
  db.deleteRepo(req.params.id);
  if (repo) log.info(`Repo deleted: ${repo.name}`);
  res.json({ ok: true });
});

// Get branches for a repo
router.get('/api/repos/:id/branches', async (req, res) => {
  const repo = db.getRepo(req.params.id);
  if (!repo) return res.status(404).json({ error: 'Repo not found' });

  try {
    const creds = db.getRepoCredentials(repo.id);
    await git.cloneOrFetch(repo.url, repo.id, creds);
    const branches = await git.getBranches(repo.id, creds);
    // Clear auth error on success
    if (repo.authStatus === 'error') db.updateRepo(repo.id, { authStatus: 'ok' });
    res.json(branches);
  } catch (err) {
    if (err.isAuthError) {
      db.markRepoAuthError(repo.id);
      return res.status(401).json({ error: err.message, authError: true });
    }
    // Return empty branches but include error info so the frontend can show it
    log.warn(`Branch listing failed for ${repo.name}: ${err.message}`);
    res.json({ branches: [], error: err.message });
  }
});

// Upload script file for a repo
router.post('/api/repos/:id/script', upload.single('script'), (req, res) => {
  const repo = db.getRepo(req.params.id);
  if (!repo) return res.status(404).json({ error: 'Repo not found' });

  if (!req.file) {
    return res.status(400).json({ error: 'No script file uploaded' });
  }

  // Rename uploaded file to keep original name + unique prefix
  const ext = path.extname(req.file.originalname) || '.sh';
  const newName = `${repo.id}-${Date.now()}${ext}`;
  const newPath = path.join(SCRIPTS_DIR, newName);

  // Remove old script file if exists
  if (repo.scriptFile && fs.existsSync(repo.scriptFile)) {
    try { fs.unlinkSync(repo.scriptFile); } catch {}
  }

  fs.renameSync(req.file.path, newPath);

  // Make script executable on Unix
  if (process.platform !== 'win32') {
    try { fs.chmodSync(newPath, 0o755); } catch {}
  }

  db.updateRepo(req.params.id, {
    scriptType: 'file',
    scriptFile: newPath,
    buildScript: req.file.originalname // display name
  });

  log.info(`Script file uploaded for ${repo.name}: ${req.file.originalname}`);
  res.json({ ok: true, fileName: req.file.originalname, path: newPath });
});

// Get repo script content (for editing)
router.get('/api/repos/:id/script', (req, res) => {
  const repo = db.getRepo(req.params.id);
  if (!repo) return res.status(404).json({ error: 'Repo not found' });

  if (repo.scriptType === 'file' && repo.scriptFile && fs.existsSync(repo.scriptFile)) {
    res.type('text/plain').sendFile(repo.scriptFile);
  } else {
    res.type('text/plain').send(repo.buildScript || '');
  }
});

// Set git credentials for a repo
router.post('/api/repos/:id/auth', async (req, res) => {
  const repo = db.getRepo(req.params.id);
  if (!repo) return res.status(404).json({ error: 'Repo not found' });

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  // Store credentials temporarily
  db.setRepoCredentials(repo.id, username, password);
  log.info(`Credentials set for ${repo.name}`);

  // Retry clone/fetch with credentials
  try {
    const creds = { user: username, pass: password };
    await git.cloneOrFetch(repo.url, repo.id, creds);
    await git.getBranches(repo.id, creds);
    db.updateRepo(repo.id, { authStatus: 'ok' });
    log.info(`Auth verified for ${repo.name}`);
    res.json({ ok: true, message: '认证成功' });
  } catch (err) {
    if (err.isAuthError) {
      db.markRepoAuthError(repo.id);
      log.warn(`Auth retry failed for ${repo.name}: ${err.message}`);
      return res.status(401).json({ error: err.message, authError: true });
    }
    log.error(`Auth retry error for ${repo.name}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Clear stored credentials
router.delete('/api/repos/:id/auth', (req, res) => {
  const repo = db.getRepo(req.params.id);
  if (!repo) return res.status(404).json({ error: 'Repo not found' });
  db.setRepoCredentials(repo.id, '', '');
  res.json({ ok: true });
});

// ---- Tasks ----

// List all tasks (optionally filter by repo)
router.get('/api/tasks', (req, res) => {
  const repoId = req.query.repoId;
  let tasks = repoId ? db.getTasksByRepo(repoId) : db.getTasks();
  // Sort by id desc
  tasks.sort((a, b) => b.id - a.id);
  // Attach repo name
  tasks = tasks.map(t => {
    const repo = db.getRepo(t.repoId);
    return { ...t, repoName: repo ? repo.name : 'Unknown' };
  });
  res.json(tasks);
});

// Get task detail
router.get('/api/tasks/:id', (req, res) => {
  const task = db.getTask(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const repo = db.getRepo(task.repoId);
  res.json({ ...task, repoName: repo ? repo.name : 'Unknown' });
});

// Get task log (streaming support)
router.get('/api/tasks/:id/log', (req, res) => {
  const task = db.getTask(Number(req.params.id));
  if (!task || !task.logFile) {
    return res.type('text/plain').send('No log available');
  }

  if (!fs.existsSync(task.logFile)) {
    return res.type('text/plain').send('Log file not found');
  }

  // If client wants streaming (for live tail)
  if (req.query.stream === 'true') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = fs.createReadStream(task.logFile, { encoding: 'utf-8' });
    stream.pipe(res);

    // If task is still running, tail the log
    if (task.status === 'running') {
      const watcher = fs.watch(task.logFile, (eventType) => {
        if (eventType === 'change') {
          try {
            const stat = fs.statSync(task.logFile);
            stream.destroy();
            const newStream = fs.createReadStream(task.logFile, {
              start: 0,
              end: stat.size,
              encoding: 'utf-8'
            });
          } catch {}
        }
      });

      res.on('close', () => {
        watcher.close();
        stream.destroy();
      });
    }
  } else {
    // Return full log
    res.type('text/plain');
    fs.createReadStream(task.logFile).pipe(res);
  }
});

// Trigger build
router.post('/api/repos/:id/build', async (req, res) => {
  const repo = db.getRepo(req.params.id);
  if (!repo) return res.status(404).json({ error: 'Repo not found' });

  const { branch } = req.body;
  if (!branch) return res.status(400).json({ error: 'branch is required' });

  if (repo.authStatus === 'error') {
    log.warn(`Build rejected for ${repo.name}: auth error`);
    return res.status(400).json({ error: '仓库认证失败，请先设置凭证', authError: true });
  }

  const task = db.addTask({ repoId: repo.id, branch });
  builder.enqueue(repo.id, task.id);
  log.info(`Build triggered: ${repo.name} / ${branch} → Task #${task.id}`);

  res.json(task);
});

// Download artifact
router.get('/api/tasks/:id/download', (req, res) => {
  const task = db.getTask(Number(req.params.id));
  if (!task || !task.artifactPath) {
    return res.status(404).json({ error: 'Artifact not found' });
  }

  if (!fs.existsSync(task.artifactPath)) {
    return res.status(404).json({ error: 'Artifact file not found' });
  }

  const fileName = path.basename(task.artifactPath);
  res.download(task.artifactPath, fileName);
});

// Delete task
router.delete('/api/tasks/:id', (req, res) => {
  const task = db.getTask(Number(req.params.id));
  if (task) {
    // Clean up artifact and log
    if (task.artifactPath && fs.existsSync(task.artifactPath)) {
      fs.unlinkSync(task.artifactPath);
    }
    if (task.logFile && fs.existsSync(task.logFile)) {
      fs.unlinkSync(task.logFile);
    }
  }
  db.deleteTask(Number(req.params.id));
  res.json({ ok: true });
});

// Manual cleanup trigger
router.post('/api/cleanup', (req, res) => {
  const cleaner = require('./cleaner');
  log.info('Manual cleanup triggered');
  cleaner.cleanup();
  res.json({ ok: true });
});

module.exports = router;
