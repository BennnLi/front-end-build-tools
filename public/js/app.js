let currentBuildRepoId = null;
let currentEditRepoId = null;
let selectedScriptFile = null;

function getToken() {
  return localStorage.getItem('build_token') || '';
}

function getRole() {
  return localStorage.getItem('build_role') || 'user';
}

function isAdmin() {
  return getRole() === 'admin';
}

async function api(url, options = {}) {
  const headers = options.headers || {};
  // Auth header
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  // Only set Content-Type for JSON requests, not for FormData
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, {
    headers,
    ...options,
    body: options.body instanceof FormData ? options.body
      : options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem('build_token');
      localStorage.removeItem('build_role');
      window.location.href = '/login.html';
      throw new Error('未登录');
    }
    if (res.status === 403) {
      throw new Error('需要管理员权限');
    }
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

// ---- Repos ----

async function loadRepos() {
  const repos = await api('/api/repos');
  const container = document.getElementById('repoList');
  if (!repos.length) {
    container.innerHTML = '<p class="empty">暂无仓库</p>';
    return;
  }
  container.innerHTML = repos.map(r => {
    const scriptDesc = r.scriptType === 'file' ? `📄 ${escapeHtml(r.buildScript)}` : escapeHtml(r.buildScript);
    const authWarn = r.authStatus === 'error'
      ? `<p style="color:#ff4d4f;margin-top:4px">⚠️ 认证失败 — <a href="javascript:openAuthModal('${r.id}')" style="color:#ff4d4f;text-decoration:underline">点击设置凭证</a></p>`
      : '';
    const hasCreds = r.authUser ? ' 🔑' : '';
    return `
    <div class="repo-item">
      <div class="repo-info">
        <h3>${escapeHtml(r.name)}${hasCreds}</h3>
        <p>${escapeHtml(r.url)} | 脚本: ${scriptDesc}${r.buildCwd ? ' | 子目录: ' + escapeHtml(r.buildCwd) : ''}${r.packDir ? ' | 打包: ' + escapeHtml(r.packDir) : ''}</p>
        <p>运行中: ${r.runningCount}/3 | 等待中: ${r.waitingCount}</p>
        ${authWarn}
      </div>
      <div class="repo-actions">
        ${isAdmin() && r.authStatus === 'error' ? `<button class="btn btn-small" style="background:#fff7e6;color:#d48806;border-color:#ffd591" onclick="openAuthModal('${r.id}')">🔐 认证</button>` : ''}
        <button class="btn btn-primary btn-small" onclick="openBuildModal('${r.id}')">构建</button>
        ${isAdmin() ? `<button class="btn btn-small" onclick="openEditModal('${r.id}')">编辑</button>` : ''}
        ${isAdmin() ? `<button class="btn btn-small btn-danger" onclick="deleteRepo('${r.id}', '${escapeHtml(r.name)}')">删除</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function addRepo(e) {
  e.preventDefault();
  const name = document.getElementById('repoName').value;
  const url = document.getElementById('repoUrl').value;
  const buildScript = document.getElementById('buildScript').value;
  const buildCwd = document.getElementById('buildCwd').value;
  const packDir = document.getElementById('packDir').value;

  try {
    await api('/api/repos', {
      method: 'POST',
      body: { name, url, buildScript, buildCwd, packDir, scriptType: 'inline' }
    });
    document.getElementById('addRepoForm').reset();
    document.getElementById('buildScript').value = 'npm install\nnpm run build';
    loadRepos();
  } catch (err) {
    alert('添加失败: ' + err.message);
  }
  return false;
}

async function deleteRepo(id, name) {
  if (!confirm(`确定删除仓库 "${name}"？相关任务也会被删除。`)) return;
  try {
    await api(`/api/repos/${id}`, { method: 'DELETE' });
    loadRepos();
    loadTasks();
  } catch (err) {
    alert('删除失败: ' + err.message);
  }
}

// ---- Edit Modal ----

async function openEditModal(repoId) {
  currentEditRepoId = repoId;
  // Fetch all repos, find the target
  const repos = await api('/api/repos');
  const repo = repos.find(r => r.id === repoId);
  if (!repo) return;

  document.getElementById('editRepoId').value = repoId;
  document.getElementById('editRepoName').textContent = repo.name;
  document.getElementById('editBuildCwd').value = repo.buildCwd || '';
  document.getElementById('editBuildCwd2').value = repo.buildCwd || '';
  document.getElementById('editPackDir').value = repo.packDir || '';
  document.getElementById('editPackDir2').value = repo.packDir || '';
  selectedScriptFile = null;
  document.getElementById('uploadInfo').style.display = 'none';
  document.getElementById('uploadPrompt').style.display = 'block';
  document.getElementById('scriptFileInput').value = '';

  if (repo.scriptType === 'file') {
    document.getElementById('tabFile').classList.remove('hidden');
    document.getElementById('tabInline').classList.add('hidden');
    document.getElementById('uploadFileName').textContent = repo.buildScript;
    document.getElementById('uploadInfo').style.display = 'block';
    document.getElementById('uploadPrompt').style.display = 'none';
    switchTab('file');
  } else {
    document.getElementById('tabInline').classList.remove('hidden');
    document.getElementById('tabFile').classList.add('hidden');
    // Load script content
    try {
      const res = await fetch(`/api/repos/${repoId}/script`, {
        headers: { 'Authorization': 'Bearer ' + getToken() }
      });
      if (res.ok) {
        document.getElementById('editBuildScript').value = await res.text();
      } else {
        document.getElementById('editBuildScript').value = repo.buildScript || '';
      }
    } catch {
      document.getElementById('editBuildScript').value = repo.buildScript || '';
    }
    switchTab('inline');
  }

  document.getElementById('editModal').classList.remove('hidden');
}

function closeEditModal() {
  document.getElementById('editModal').classList.add('hidden');
  currentEditRepoId = null;
  selectedScriptFile = null;
}

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tab}"]`).classList.add('active');
  if (tab === 'inline') {
    document.getElementById('tabInline').classList.remove('hidden');
    document.getElementById('tabFile').classList.add('hidden');
  } else {
    document.getElementById('tabInline').classList.add('hidden');
    document.getElementById('tabFile').classList.remove('hidden');
  }
}

function onFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  selectedScriptFile = file;
  document.getElementById('uploadFileName').textContent = file.name;
  document.getElementById('uploadInfo').style.display = 'block';
  document.getElementById('uploadPrompt').style.display = 'none';
}

function clearFile() {
  selectedScriptFile = null;
  document.getElementById('scriptFileInput').value = '';
  document.getElementById('uploadInfo').style.display = 'none';
  document.getElementById('uploadPrompt').style.display = 'block';
}

async function saveEdit() {
  const repoId = document.getElementById('editRepoId').value;

  // Determine which tab is active
  const inlineTab = document.getElementById('tabInline');
  const isInlineActive = !inlineTab.classList.contains('hidden');

  try {
    if (isInlineActive) {
      // Save inline script
      const buildScript = document.getElementById('editBuildScript').value;
      const buildCwd = document.getElementById('editBuildCwd').value;
      const packDir = document.getElementById('editPackDir').value;
      await api(`/api/repos/${repoId}`, {
        method: 'PUT',
        body: { buildScript, buildCwd: buildCwd || '', packDir: packDir || '', scriptType: 'inline', scriptFile: '' }
      });
    } else {
      // Save file script
      const buildCwd = document.getElementById('editBuildCwd2').value;
      const packDir = document.getElementById('editPackDir2').value;

      if (selectedScriptFile) {
        // Upload the script file
        const formData = new FormData();
        formData.append('script', selectedScriptFile);
        await fetch(`/api/repos/${repoId}/script`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + getToken() },
          body: formData
        }).then(r => r.json());
      }

      // Update buildCwd and packDir
      await api(`/api/repos/${repoId}`, {
        method: 'PUT',
        body: { buildCwd: buildCwd || '', packDir: packDir || '' }
      });
    }

    closeEditModal();
    loadRepos();
  } catch (err) {
    alert('保存失败: ' + err.message);
  }
}

// ---- Build Modal ----

async function openBuildModal(repoId) {
  currentBuildRepoId = repoId;
  const repos = await api('/api/repos');
  const repo = repos.find(r => r.id === repoId);
  document.getElementById('buildRepoName').textContent = repo ? repo.name : '';

  const select = document.getElementById('branchSelect');
  select.innerHTML = '<option>加载中...</option>';
  document.getElementById('branchCommits').style.display = 'none';
  document.getElementById('commitList').innerHTML = '';
  document.getElementById('buildModal').classList.remove('hidden');

  try {
    // Use api() so the Authorization header is included
    const res = await fetch(`/api/repos/${repoId}/branches`, {
      headers: { 'Authorization': 'Bearer ' + getToken() }
    });
    const result = await res.json();
    const branches = Array.isArray(result) ? result : (result.branches || []);
    const fetchError = Array.isArray(result) ? null : result.error;

    if (branches.length > 0) {
      select.innerHTML = branches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
      // Trigger commit display for the auto-selected branch
      onBranchChange();
    } else if (fetchError) {
      const short = fetchError.length > 80 ? fetchError.substring(0, 80) + '...' : fetchError;
      select.innerHTML = `<option>⚠ ${escapeHtml(short)}</option>`;
    } else {
      select.innerHTML = '<option>无可用分支</option>';
    }
  } catch (err) {
    if (err.message && (err.message.includes('Auth') || err.message.includes('auth') || err.message.includes('401') || err.message.includes('403') || err.message.includes('Authentication'))) {
      select.innerHTML = '<option>认证失败，请先设置凭证</option>';
      closeBuildModal();
      openAuthModal(repoId);
    } else {
      select.innerHTML = '<option>获取分支失败</option>';
    }
  }
}

async function onBranchChange() {
  const branch = document.getElementById('branchSelect').value;
  if (!branch || branch.includes('无可用') || branch.includes('加载') || branch.includes('失败') || branch.includes('⚠')) return;

  const el = document.getElementById('branchCommits');
  const list = document.getElementById('commitList');
  el.style.display = 'block';
  list.innerHTML = '<span style="color:#999;font-size:12px">加载中...</span>';

  try {
    const res = await fetch(`/api/repos/${currentBuildRepoId}/commits?branch=${encodeURIComponent(branch)}`, {
      headers: { 'Authorization': 'Bearer ' + getToken() }
    });
    if (!res.ok) { list.innerHTML = ''; return; }
    const commits = await res.json();
    if (!commits.length) {
      list.innerHTML = '<span style="color:#999;font-size:12px">暂无提交</span>';
      return;
    }
    list.innerHTML = commits.map(c => `
      <div class="commit-item">
        <span class="commit-hash">${escapeHtml(c.shortHash)}</span>
        ${escapeHtml(c.message)}
        <div class="commit-meta">${escapeHtml(c.author)} · ${c.date}</div>
      </div>
    `).join('');
  } catch {
    list.innerHTML = '';
  }
}

function closeBuildModal() {
  document.getElementById('buildModal').classList.add('hidden');
  currentBuildRepoId = null;
}

async function triggerBuild() {
  const branch = document.getElementById('branchSelect').value;
  if (!branch || branch.includes('无可用') || branch.includes('加载') || branch.includes('失败')) {
    alert('请选择有效分支');
    return;
  }

  try {
    await api(`/api/repos/${currentBuildRepoId}/build`, {
      method: 'POST',
      body: { branch }
    });
    closeBuildModal();
    loadTasks();
    loadRepos();
  } catch (err) {
    if (err.message.includes('认证失败') || err.message.includes('auth')) {
      closeBuildModal();
      openAuthModal(currentBuildRepoId);
    } else {
      alert('构建失败: ' + err.message);
    }
  }
}

// ---- Auth Modal ----

async function openAuthModal(repoId) {
  const repos = await api('/api/repos');
  const repo = repos.find(r => r.id === repoId);
  if (!repo) return;

  document.getElementById('authRepoId').value = repoId;
  document.getElementById('authRepoName').textContent = `${repo.name} — ${repo.url}`;
  document.getElementById('authErrorMsg').textContent = '该仓库无法通过认证，请输入有效的凭证。';
  document.getElementById('authUsername').value = '';
  document.getElementById('authPassword').value = '';
  document.getElementById('authModal').classList.remove('hidden');
}

function closeAuthModal() {
  document.getElementById('authModal').classList.add('hidden');
}

async function submitAuth() {
  const repoId = document.getElementById('authRepoId').value;
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value.trim();

  if (!username || !password) {
    alert('请填写用户名和密码/Token');
    return;
  }

  try {
    const result = await api(`/api/repos/${repoId}/auth`, {
      method: 'POST',
      body: { username, password }
    });
    closeAuthModal();
    loadRepos();
    alert(result.message || '认证成功');
  } catch (err) {
    document.getElementById('authErrorMsg').textContent = '认证失败: ' + err.message;
  }
}

// ---- Tasks ----

async function loadTasks() {
  const tasks = await api('/api/tasks');
  const container = document.getElementById('taskList');
  if (!tasks.length) {
    container.innerHTML = '<p class="empty">暂无任务</p>';
    return;
  }
  container.innerHTML = tasks.map(t => `
    <div class="task-item">
      <a class="task-id" href="/detail.html?id=${t.id}">#${t.id}</a>
      <div class="task-info">
        <div class="task-title">${escapeHtml(t.repoName)} / ${escapeHtml(t.branch)}</div>
        <div class="task-meta">
          ${t.startedAt ? '开始: ' + formatTime(t.startedAt) : ''}
          ${t.finishedAt ? ' | 完成: ' + formatTime(t.finishedAt) : ''}
          ${t.startedAt && t.finishedAt ? ' | 耗时: ' + calcDuration(t.startedAt, t.finishedAt) : ''}
        </div>
      </div>
      <span class="status status-${t.status}">${statusText(t.status)}</span>
      <div class="task-actions">
        ${t.status === 'success' ? `<a class="btn btn-small btn-success" href="/api/tasks/${t.id}/download">下载</a>` : ''}
        ${isAdmin() && (t.status === 'success' || t.status === 'failed') ? `<button class="btn btn-small btn-danger" onclick="deleteTask(${t.id})">删除</button>` : ''}
      </div>
    </div>
  `).join('');
}

async function deleteTask(id) {
  if (!confirm('确定删除该任务？')) return;
  try {
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    loadTasks();
    loadRepos();
  } catch (err) {
    alert('删除失败: ' + err.message);
  }
}

// ---- Cleanup ----

async function triggerCleanup() {
  if (!confirm('确定清理所有构建产物？此操作不可恢复。')) return;
  try {
    await api('/api/cleanup', { method: 'POST' });
    loadTasks();
    alert('清理完成');
  } catch (err) {
    alert('清理失败: ' + err.message);
  }
}

// ---- Upload drag & drop ----

(function setupUpload() {
  const area = document.getElementById('uploadArea');
  if (!area) return;

  area.addEventListener('click', () => {
    document.getElementById('scriptFileInput').click();
  });

  area.addEventListener('dragover', (e) => {
    e.preventDefault();
    area.classList.add('dragover');
  });

  area.addEventListener('dragleave', () => {
    area.classList.remove('dragover');
  });

  area.addEventListener('drop', (e) => {
    e.preventDefault();
    area.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) {
      selectedScriptFile = file;
      document.getElementById('uploadFileName').textContent = file.name;
      document.getElementById('uploadInfo').style.display = 'block';
      document.getElementById('uploadPrompt').style.display = 'none';
    }
  });
})();

// ---- Logout ----

async function logout() {
  const token = getToken();
  if (token) {
    await fetch('/api/logout', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token }
    });
  }
  localStorage.removeItem('build_token');
  localStorage.removeItem('build_role');
  window.location.href = '/login.html';
}

// ---- Helpers ----

function refreshAll() {
  loadRepos();
  loadTasks();
}

function statusText(s) {
  return { waiting: '等待中', running: '构建中', success: '成功', failed: '失败' }[s] || s;
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('zh-CN');
}

function calcDuration(start, end) {
  const ms = new Date(end) - new Date(start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + '秒';
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return m + '分' + rs + '秒';
  const h = Math.floor(m / 60);
  return h + '时' + (m % 60) + '分';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Auto-refresh every 5 seconds
let autoRefreshTimer;
function startAutoRefresh() {
  autoRefreshTimer = setInterval(() => {
    loadRepos();
    loadTasks();
  }, 5000);
}

// Init — check auth first, then apply role-based visibility
if (!getToken()) {
  window.location.href = '/login.html';
} else {
  // Hide admin-only UI for regular users
  if (!isAdmin()) {
    // Hide add repo form section
    const addCard = document.querySelector('#addRepoForm').closest('.card');
    if (addCard) addCard.style.display = 'none';
    // Hide cleanup button
    const cleanupBtn = document.querySelector('.btn-danger[onclick="triggerCleanup()"]');
    if (cleanupBtn) cleanupBtn.style.display = 'none';
  }

  loadRepos();
  loadTasks();
  startAutoRefresh();
}
