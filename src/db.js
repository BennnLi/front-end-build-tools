const fs = require('fs');
const path = require('path');
const log = require('./logger').createLogger('db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_DATA = {
  repos: [],
  tasks: [],
  nextTaskId: 1
};

function read() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf-8');
      log.debug('Database initialized');
      return JSON.parse(JSON.stringify(DEFAULT_DATA));
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch (e) {
    log.error(`Failed to read database: ${e.message}`);
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

function write(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    log.error(`Failed to write database: ${e.message}`);
    throw e;
  }
}

// ---- Repos ----

function getRepos() {
  return read().repos;
}

function getRepo(id) {
  return read().repos.find(r => r.id === id) || null;
}

function addRepo({ name, url, buildScript, buildCwd, scriptType, scriptFile, packDir, authUser, authPass }) {
  const data = read();
  const repo = {
    id: require('uuid').v4(),
    name,
    url,
    buildScript: buildScript || 'npm install && npx vite build',
    buildCwd: buildCwd || '',
    scriptType: scriptType || 'inline', // 'inline' | 'file'
    scriptFile: scriptFile || '',        // path to uploaded script file
    packDir: packDir || '',              // subdirectory to package (relative to buildCwd), e.g. "dist"
    authStatus: 'ok',                    // 'ok' | 'error' — authentication status
    authUser: authUser || '',            // git credential username
    authPass: authPass || '',            // git credential password/token
    createdAt: new Date().toISOString()
  };
  data.repos.push(repo);
  write(data);
  return repo;
}

function updateRepo(id, updates) {
  const data = read();
  const idx = data.repos.findIndex(r => r.id === id);
  if (idx === -1) return null;
  Object.assign(data.repos[idx], updates);
  write(data);
  return data.repos[idx];
}

function deleteRepo(id) {
  const data = read();
  data.repos = data.repos.filter(r => r.id !== id);
  // also remove associated tasks
  data.tasks = data.tasks.filter(t => t.repoId !== id);
  write(data);
}

// ---- Tasks ----

function getTasks() {
  return read().tasks;
}

function getTasksByRepo(repoId) {
  return read().tasks.filter(t => t.repoId === repoId);
}

function getTask(taskId) {
  return read().tasks.find(t => t.id === taskId) || null;
}

function addTask({ repoId, branch }) {
  const data = read();
  // Calculate per-repo task number
  const repoTasks = data.tasks.filter(t => t.repoId === repoId);
  const repoTaskNum = repoTasks.length > 0 ? Math.max(...repoTasks.map(t => t.repoTaskNum || 0)) + 1 : 1;

  const task = {
    id: data.nextTaskId++,
    repoId,
    repoTaskNum,
    branch,
    status: 'waiting', // waiting | running | success | failed
    logFile: '',
    artifactPath: '',
    commits: [],
    startedAt: null,
    finishedAt: null,
    createdAt: new Date().toISOString()
  };
  data.tasks.push(task);
  write(data);
  return task;
}

function updateTask(taskId, updates) {
  const data = read();
  const idx = data.tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return null;
  Object.assign(data.tasks[idx], updates);
  write(data);
  return data.tasks[idx];
}

function deleteTask(taskId) {
  const data = read();
  data.tasks = data.tasks.filter(t => t.id !== taskId);
  write(data);
}

// ---- Credentials ----

function setRepoCredentials(id, user, pass) {
  return updateRepo(id, {
    authUser: user || '',
    authPass: pass || '',
    authStatus: 'ok'
  });
}

function getRepoCredentials(id) {
  const repo = getRepo(id);
  if (!repo || !repo.authUser || !repo.authPass) return null;
  return { user: repo.authUser, pass: repo.authPass };
}

function markRepoAuthError(id) {
  return updateRepo(id, { authStatus: 'error' });
}

module.exports = {
  getRepos, getRepo, addRepo, updateRepo, deleteRepo,
  getTasks, getTasksByRepo, getTask, addTask, updateTask, deleteTask,
  setRepoCredentials, getRepoCredentials, markRepoAuthError
};
