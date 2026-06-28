function getToken() {
  return localStorage.getItem('build_token') || '';
}

function logout() {
  localStorage.removeItem('build_token');
  localStorage.removeItem('build_role');
  window.location.href = '/login.html';
}

async function api(url, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { headers, ...options });
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem('build_token');
      window.location.href = '/login.html';
      throw new Error('未登录');
    }
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN');
}

function calcDuration(start, end) {
  if (!start || !end) return '-';
  const ms = new Date(end) - new Date(start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + '秒';
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return m + '分' + rs + '秒';
  const h = Math.floor(m / 60);
  return h + '时' + (m % 60) + '分';
}

function statusText(s) {
  return { waiting: '等待中', running: '构建中', success: '成功', failed: '失败' }[s] || s;
}

async function loadTaskDetail() {
  const params = new URLSearchParams(window.location.search);
  const taskId = params.get('id');
  if (!taskId) {
    document.getElementById('taskInfo').innerHTML = '<p>缺少任务ID</p>';
    return;
  }

  try {
    const task = await api(`/api/tasks/${taskId}`);

    // Render task info
    document.getElementById('taskInfo').innerHTML = `
      <div class="detail-header">
        <h2>${escapeHtml(task.repoName)} 任务 #${task.id}</h2>
        <div>
          <span class="status status-${task.status}">${statusText(task.status)}</span>
          ${task.status === 'success' ? `<a class="btn btn-small btn-success" href="/api/tasks/${task.id}/download" style="margin-left:8px">下载产物</a>` : ''}
        </div>
      </div>
      <dl class="detail-grid">
        <dt>仓库</dt><dd>${escapeHtml(task.repoName)}</dd>
        <dt>分支</dt><dd>${escapeHtml(task.branch)}</dd>
        <dt>创建时间</dt><dd>${formatTime(task.createdAt)}</dd>
        <dt>开始时间</dt><dd>${formatTime(task.startedAt)}</dd>
        <dt>完成时间</dt><dd>${formatTime(task.finishedAt)}</dd>
        <dt>耗时</dt><dd>${calcDuration(task.startedAt, task.finishedAt)}</dd>
      </dl>
    `;

    // Render commits
    if (task.commits && task.commits.length) {
      document.getElementById('commitSection').style.display = '';
      document.getElementById('commitList').innerHTML = task.commits.map(c => `
        <div class="commit-item">
          <span class="commit-hash">${escapeHtml(c.shortHash)}</span>
          ${escapeHtml(c.message)}
          <div class="commit-meta">${escapeHtml(c.author)} · ${c.date}</div>
        </div>
      `).join('');
    }

    // Render log
    if (task.logFile || task.status === 'running') {
      document.getElementById('logSection').style.display = '';
      await loadLog(taskId, task.status);
    }

    // Auto-refresh if still running or waiting
    if (task.status === 'running' || task.status === 'waiting') {
      setTimeout(loadTaskDetail, 3000);
    }
  } catch (err) {
    document.getElementById('taskInfo').innerHTML = `<p>加载失败: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadLog(taskId, status) {
  try {
    const res = await fetch(`/api/tasks/${taskId}/log`);
    const text = await res.text();
    document.getElementById('logContent').textContent = text || '暂无日志';
    // Auto scroll to bottom
    const logEl = document.getElementById('logContent');
    logEl.scrollTop = logEl.scrollHeight;
  } catch {
    document.getElementById('logContent').textContent = '无法加载日志';
  }
}

// Check auth first
if (!getToken()) {
  window.location.href = '/login.html';
} else {
  loadTaskDetail();
}
