const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const log = require('./logger').createLogger('git');

const REPOS_DIR = path.join(__dirname, '..', 'data', 'repos');

// Custom error type for authentication failures
class AuthError extends Error {
  constructor(message, originalError) {
    super(message);
    this.name = 'AuthError';
    this.isAuthError = true;
    this.originalError = originalError;
  }
}

// Patterns that indicate an authentication/authorization failure
const AUTH_PATTERNS = [
  /Authentication failed/i,
  /fatal: could not read Username/i,
  /fatal: could not read Password/i,
  /fatal: unable to access.*403/i,
  /fatal: unable to access.*401/i,
  /remote: Invalid username or password/i,
  /remote: Not authorized/i,
  /fatal: Authentication canceled/i,
  /could not read from remote/i,
  /Permission denied.*publickey/i,
  /Host key verification failed/i,
  /Please make sure you have the correct access rights/i,
  // GitHub returns 404 for private repos you don't have access to
  /Repository not found/i,
  /returned status code 403/i,
  /returned status code 401/i,
];

function isAuthError(stderr) {
  return AUTH_PATTERNS.some(p => p.test(stderr));
}

// Patterns that are non-critical / expected git warnings
const SOFT_FAIL_PATTERNS = [
  /failed to resolve HEAD as a valid ref/i,
  /does not have any commits yet/i,
  /does not have a checked out branch/i,
  /no such ref/i,
  /ambiguous argument/i,
  /couldn't find remote ref/i,
  /SSL_ERROR_SYSCALL/i,
  /Could not resolve host/i,
  /connection timed out/i,
  /could not read from remote repository/i,
];

function isSoftFail(stderr) {
  return SOFT_FAIL_PATTERNS.some(p => p.test(stderr));
}

function execGit(args, cwd, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...envOverrides };
    log.debug(`git ${args.join(' ')}`, { cwd: cwd || '.' });
    execFile('git', args, { cwd, env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (stderr && isAuthError(stderr)) {
          log.warn(`Auth error: ${stderr.trim().split('\n')[0]}`);
          return reject(new AuthError(stderr, err));
        }
        if (stderr && isSoftFail(stderr)) {
          log.warn(`git ${args[0]}: ${stderr.trim().split('\n')[0]}`);
        } else {
          log.error(`git ${args[0]} failed: ${(stderr || err.message).trim().split('\n')[0]}`);
        }
        return reject(new Error(stderr || err.message));
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Build an authenticated URL by embedding credentials.
 * https://user:token@github.com/user/repo.git
 */
function buildAuthUrl(url, user, pass) {
  if (!user || !pass) return url;
  try {
    const u = new URL(url);
    u.username = encodeURIComponent(user);
    u.password = encodeURIComponent(pass);
    return u.toString();
  } catch {
    // If URL parsing fails, try simple replacement for git@ URLs
    return url;
  }
}

function getRepoPath(repoId) {
  return path.join(REPOS_DIR, repoId);
}

function isGitRepo(repoPath) {
  return fs.existsSync(path.join(repoPath, 'HEAD')) ||
         fs.existsSync(path.join(repoPath, '.git', 'HEAD'));
}

async function cloneOrFetch(repoUrl, repoId, credentials = null) {
  const repoPath = getRepoPath(repoId);
  const url = credentials ? buildAuthUrl(repoUrl, credentials.user, credentials.pass) : repoUrl;

  if (isGitRepo(repoPath)) {
    log.info(`Fetching: ${repoUrl}`);
    await execGit(['remote', 'set-url', 'origin', url], repoPath);
    await execGit(['fetch', '--all', '--prune'], repoPath);
    await execGit(['remote', 'set-url', 'origin', repoUrl], repoPath);
  } else {
    log.info(`Cloning (bare): ${repoUrl}`);
    if (fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }
    fs.mkdirSync(repoPath, { recursive: true });
    await execGit(['clone', '--bare', url, repoPath]);
    await execGit(['remote', 'set-url', 'origin', repoUrl], repoPath);
  }
}

async function getBranches(repoId, credentials = null) {
  const repoPath = getRepoPath(repoId);
  if (!isGitRepo(repoPath)) return [];

  const repo = require('./db').getRepo(repoId);
  if (!repo) return [];

  try {
    // Use -a (all) to cover both local and remote-tracking refs in bare repos
    const output = await execGit(['branch', '-a'], repoPath);
    const branches = output
      .split('\n')
      .map(b => b.trim().replace(/^\* /, ''))
      .filter(b => b && !b.includes('->'))
      .map(b => b.replace(/^remotes\/origin\//, ''))
      .filter(b => !b.startsWith('remotes/') && b !== 'HEAD');

    return [...new Set(branches)];
  } catch (err) {
    throw err;
  }
}

async function getLatestCommits(repoId, branch, count = 5) {
  const repoPath = getRepoPath(repoId);
  if (!isGitRepo(repoPath)) return [];
  try {
    const output = await execGit(
      ['log', branch, `-${count}`, '--pretty=format:%H|%h|%an|%s|%ci'],
      repoPath
    );
    if (!output) return [];
    return output.split('\n').map(line => {
      const [hash, shortHash, author, message, date] = line.split('|');
      return { hash, shortHash, author, message, date };
    });
  } catch {
    return [];
  }
}

async function checkoutBranch(repoId, branch, workDir, credentials = null) {
  const repo = require('./db').getRepo(repoId);
  if (!repo) throw new Error('Repo not found');

  const url = credentials ? buildAuthUrl(repo.url, credentials.user, credentials.pass) : repo.url;

  if (fs.existsSync(workDir)) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  fs.mkdirSync(workDir, { recursive: true });

  log.info(`Checking out branch "${branch}" to workdir`);
  await execGit(['clone', '--branch', branch, '--depth', '50', url, workDir]);
}

module.exports = {
  AuthError,
  isAuthError,
  isSoftFail,
  buildAuthUrl,
  cloneOrFetch,
  getBranches,
  getLatestCommits,
  checkoutBranch,
  getRepoPath
};
