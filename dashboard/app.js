/* ============================================================
   Ara Dashboard — SPA Engine
   Neo-brutalist / manga aesthetic · Strict B&W
   ============================================================ */

/* ─── State ─────────────────────────────────────────────────── */
const state = {
  token: null,
  refreshTimer: null,
  pageRefreshTimer: null,
  charts: {},
  logsFilterLevel: 'all',
  chatSelectedNumber: null
};

/* ─── DOM refs (set after DOM ready) ────────────────────────── */
let $ = (sel) => document.querySelector(sel);
let $$ = (sel) => document.querySelectorAll(sel);

/* ─── API wrapper ───────────────────────────────────────────── */
async function api(path, options = {}) {
  const headers = { 'Accept': 'application/json', ...options.headers };

  // Don't set Content-Type for GET/HEAD, do for POST/PUT
  if (options.method && !['GET', 'HEAD'].includes(options.method)) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const res = await fetch('/api' + path, { ...options, headers });
    if (res.status === 401) {
      state.token = null;
      location.hash = '#login';
      return null;
    }
    if (res.status === 204) return {};
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    console.warn('[API] fetch error:', path, err.message);
    return null;
  }
}

/* ─── Page loader (fetch HTML fragment) ────────────────────── */
let pageCache = {};

async function loadPageHTML(name) {
  if (pageCache[name]) return pageCache[name];
  try {
    const res = await fetch(name + '.html');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    pageCache[name] = html;
    return html;
  } catch (err) {
    console.warn('[Page] failed to load', name, err.message);
    return '<div class="panel error-panel"><p>Gagal memuat halaman ' + name + '</p></div>';
  }
}

/* ─── Toast notification ────────────────────────────────────── */
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ─── Router ────────────────────────────────────────────────── */
function router() {
  const hash = location.hash.slice(1) || 'login';

  // Auth guard
  if (!state.token && hash !== 'login') {
    location.hash = 'login';
    return;
  }

  // Show/hide shells
  const loginShell = $('#login-shell');
  const appShell = $('#app-shell');
  if (!loginShell || !appShell) return;

  if (hash === 'login') {
    loginShell.classList.remove('hidden');
    appShell.classList.add('hidden');
    stopAutoRefresh();
    return;
  }

  loginShell.classList.add('hidden');
  appShell.classList.remove('hidden');

  // Highlight nav — sidebar links
  $$('.sidebar-nav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + hash);
  });

  // Load page content
  renderPage(hash);
}

/* ─── Page render dispatch ──────────────────────────────────── */
async function renderPage(name) {
  const container = $('#page-content');
  if (!container) return;

  // Stop any previous auto-refresh timers
  stopAutoRefresh();
  clearPageRefresh();

  // Set title (Bahasa Indonesia)
  const titles = { ringkasan: 'Ringkasan', pengaturan: 'Pengaturan', 'log-sistem': 'Log Sistem', percakapan: 'Percakapan', debug: 'Debug', statistik: 'Statistik' };
  $('#page-title').textContent = titles[name] || name;

  // Map Bahasa hash names to actual file names
  const pageFiles = { ringkasan: 'overview', percakapan: 'chat', statistik: 'analytics', 'log-sistem': 'logs', pengaturan: 'settings', debug: 'debug' };
  const pageFile = pageFiles[name] || name;

  container.innerHTML = '<div class="loader"></div>';

  const html = await loadPageHTML(pageFile);
  container.innerHTML = html;

  // Init page (Bahasa hash names)
  if (name === 'ringkasan') initOverview();
  else if (name === 'pengaturan') initSettings();
  else if (name === 'log-sistem') initLogs();
  else if (name === 'percakapan') initChat();
  else if (name === 'debug') initDebug();
  else if (name === 'statistik') initAnalytics();
}

/* ─── Login ─────────────────────────────────────────────────── */
async function handleLogin(password) {
  const btn = $('#login-btn');
  if (btn) { btn.disabled = true; btn.textContent = '...'; }

  const data = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password })
  });

  if (btn) { btn.disabled = false; btn.textContent = 'Login'; }

  if (data && data.token) {
    state.token = data.token;
    toast('Login berhasil');
    location.hash = '#ringkasan';
  } else {
    toast('Password salah');
    const inp = $('#login-password');
    if (inp) { inp.value = ''; inp.focus(); }
  }
}

/* ─── Logout ────────────────────────────────────────────────── */
function handleLogout() {
  state.token = null;
  stopAutoRefresh();
  location.hash = '#login';
  toast('Logout');
}

/* ─── Auto-refresh ──────────────────────────────────────────── */
let refreshCountdown = 0;
let refreshIntervalId = null;

function startAutoRefresh() {
  stopAutoRefresh();
  refreshCountdown = 30;
  updateCountdownBadge();
  refreshIntervalId = setInterval(() => {
    refreshCountdown--;
    updateCountdownBadge();
    if (refreshCountdown <= 0) {
      refreshCountdown = 30;
      if (location.hash === '#ringkasan') {
        renderPage('ringkasan');
      }
    }
  }, 1000);
}

function stopAutoRefresh() {
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
}

function updateCountdownBadge() {
  const badge = $('#refresh-badge');
  if (badge) badge.textContent = refreshCountdown + 's';
}

/* ─── Page-level auto-refresh ────────────────────────────────── */
function setPageRefresh(fn, intervalMs) {
  if (state.pageRefreshTimer) {
    clearInterval(state.pageRefreshTimer);
    state.pageRefreshTimer = null;
  }
  state.pageRefreshTimer = setInterval(fn, intervalMs);
}

function clearPageRefresh() {
  if (state.pageRefreshTimer) {
    clearInterval(state.pageRefreshTimer);
    state.pageRefreshTimer = null;
  }
}

/* ─── Overview Page ─────────────────────────────────────────── */
let overviewData = {};

async function initOverview() {
  startAutoRefresh();

  // Fetch data
  const [stats, friends, messages] = await Promise.all([
    api('/overview/today'),
    api('/friends'),
    api('/messages?range=7d')
  ]);

  overviewData = { stats, friends, messages };

  renderOverviewStats(stats);
  renderOverviewFriends(friends);
  renderOverviewChart(messages);

  // Manual refresh button
  const btn = $('#refresh-btn');
  if (btn) {
    btn.onclick = async () => {
      btn.classList.add('spinning');
      refreshCountdown = 30;
      await initOverview();
      btn.classList.remove('spinning');
    };
  }
}

function renderOverviewStats(stats) {
  const grid = $('#ov-stats-grid');
  if (!grid) return;

  const s = stats || {};
  const today = s.today || {};
  const deltas = s.deltas || {};

  grid.innerHTML = `
    <div class="panel stat-card">
      <div class="stat-label">Status Model</div>
      <div class="stat-value">${(s.status || 'offline').toUpperCase()}</div>
      <div class="stat-meta">Uptime ${fmtUptime(s.uptime)}</div>
    </div>
    <div class="panel stat-card">
      <div class="stat-label">Pesan Hari Ini</div>
      <div class="stat-value">${fmtNum(today.messages)}</div>
      <div class="stat-meta">${deltaStr(deltas.messages)}</div>
    </div>
    <div class="panel stat-card">
      <div class="stat-label">Total Token</div>
      <div class="stat-value">${fmtNum(today.tokens)}</div>
      <div class="stat-meta">${deltaStr(deltas.tokens)}</div>
    </div>
    <div class="panel stat-card">
      <div class="stat-label">User Aktif</div>
      <div class="stat-value">${fmtNum(today.activeUsers)}</div>
      <div class="stat-meta">${deltaStr(deltas.activeUsers)}</div>
    </div>
    <div class="panel stat-card">
      <div class="stat-label">LLM Calls</div>
      <div class="stat-value">${fmtNum(today.llmCalls)}</div>
      <div class="stat-meta">${deltaStr(deltas.llmCalls)}</div>
    </div>
    <div class="panel stat-card">
      <div class="stat-label">Auto-Chat</div>
      <div class="stat-value">${fmtNum(today.autoChat || 0)}</div>
      <div class="stat-meta">${s.autoChatPct != null ? s.autoChatPct + '% dari total' : '-'}</div>
    </div>
  `;
}

function renderOverviewFriends(friends) {
  const list = $('#ov-friends-list');
  if (!list) return;

  const f = friends || [];
  if (f.length === 0) {
    list.innerHTML = '<div class="panel empty-panel"><p>Belum ada teman terdaftar</p></div>';
    return;
  }

  list.innerHTML = f.map(friend => `
    <div class="panel friend-card">
      <div class="friend-avatar">${(friend.name || '?')[0].toUpperCase()}</div>
      <div class="friend-info">
        <div class="friend-name">${friend.name || 'Tanpa Nama'}</div>
        <div class="friend-mood">${friend.mood || '---'}</div>
      </div>
      <div class="friend-status ${friend.online ? 'online' : 'offline'}"></div>
    </div>
  `).join('');
}

function renderOverviewChart(messages) {
  const canvas = $('#ov-chart');
  if (!canvas || !window.Chart) return;

  // Destroy previous
  if (state.charts.ovMsg) {
    state.charts.ovMsg.destroy();
  }

  const days = messages?.days || [];
  const labels = days.length ? days.map(d => d.date.slice(5)) : ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
  const sent = days.map(d => d.sent || 0);
  const received = days.map(d => d.received || 0);

  state.charts.ovMsg = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Terkirim',
          data: sent.length ? sent : [0, 0, 0, 0, 0, 0, 0],
          borderColor: '#000',
          backgroundColor: 'rgba(0,0,0,0.06)',
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: '#000',
          borderWidth: 2
        },
        {
          label: 'Diterima',
          data: received.length ? received : [0, 0, 0, 0, 0, 0, 0],
          borderColor: '#666',
          backgroundColor: 'rgba(0,0,0,0.03)',
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: '#666',
          borderWidth: 2,
          borderDash: [4, 4]
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: { font: { family: 'Inter, sans-serif', size: 11 }, boxWidth: 12, usePointStyle: true }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(0,0,0,0.06)', drawTicks: false },
          ticks: { font: { family: 'Inter, sans-serif', size: 10 } }
        },
        y: {
          grid: { color: 'rgba(0,0,0,0.06)', drawTicks: false },
          ticks: { font: { family: 'Inter, sans-serif', size: 10 }, maxTicksLimit: 6 }
        }
      },
      interaction: { intersect: false, mode: 'index' }
    }
  });
}

/* ─── Settings Page ─────────────────────────────────────────── */
async function initSettings() {
  stopAutoRefresh();

  // Fetch current settings from API
  const [personality, config] = await Promise.all([
    api('/personality'),
    api('/config')
  ]);

  // Personality textarea
  const ta = $('#settings-personality');
  if (ta) {
    // Try to get full content from API, fallback to placeholder
    if (personality && personality.content) {
      ta.value = personality.content;
    } else {
      ta.placeholder = 'Memuat personality.txt...';
      // Fetch raw file
      try {
        const res = await fetch('/personality.txt');
        if (res.ok) ta.value = await res.text();
      } catch (e) {
        ta.placeholder = 'Gagal memuat personality.txt';
      }
    }
  }

  // Auto-chat toggle
  const autoChatToggle = $('#toggle-autochat');
  if (autoChatToggle) {
    autoChatToggle.checked = config?.autoChat !== false;
    autoChatToggle.onchange = async () => {
      await api('/config', {
        method: 'PUT',
        body: JSON.stringify({ autoChat: autoChatToggle.checked })
      });
      toast('Auto-chat ' + (autoChatToggle.checked ? 'ON' : 'OFF'));
    };
  }

  // Circuit breaker toggle
  const cbToggle = $('#toggle-circuitbreaker');
  if (cbToggle) {
    cbToggle.checked = config?.circuitBreaker !== false;
    cbToggle.onchange = async () => {
      await api('/config', {
        method: 'PUT',
        body: JSON.stringify({ circuitBreaker: cbToggle.checked })
      });
      toast('Circuit breaker ' + (cbToggle.checked ? 'ON' : 'OFF'));
    };
  }

  // Blacklist
  const bl = $('#settings-blacklist');
  if (bl) {
    const list = config?.blacklist || [];
    bl.value = Array.isArray(list) ? list.join(', ') : '';
    bl.onchange = async () => {
      const val = bl.value.split(',').map(s => s.trim()).filter(Boolean);
      await api('/config', {
        method: 'PUT',
        body: JSON.stringify({ blacklist: val })
      });
      toast('Blacklist disimpan');
    };
  }

  // Save personality button
  const saveBtn = $('#save-personality-btn');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      if (!ta) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Menyimpan...';
      await api('/personality', {
        method: 'PUT',
        body: JSON.stringify({ content: ta.value })
      });
      saveBtn.disabled = false;
      saveBtn.textContent = 'Simpan Personality';
      toast('Personality tersimpan');
    };
  }
}

/* ─── Logs Page ──────────────────────────────────────────────── */
async function initLogs() {
  clearPageRefresh();
  setPageRefresh(fetchLogs, 10000);

  await fetchLogs();

  // Level filter
  const levelSelect = $('#logs-level');
  if (levelSelect) {
    levelSelect.value = state.logsFilterLevel || 'all';
    levelSelect.onchange = () => {
      state.logsFilterLevel = levelSelect.value;
      renderLogsTable();
    };
  }

  // Clear button
  const clearBtn = $('#logs-clear-btn');
  if (clearBtn) {
    clearBtn.onclick = async () => {
      clearBtn.classList.add('spinning');
      await api('/logs/clear', { method: 'POST' });
      clearBtn.classList.remove('spinning');
      toast('Logs cleared');
      await fetchLogs();
    };
  }

  // Manual refresh via topbar button
  const refreshBtn = $('#refresh-btn');
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      refreshBtn.classList.add('spinning');
      await fetchLogs();
      refreshBtn.classList.remove('spinning');
    };
  }
}

let logsData = [];

async function fetchLogs() {
  const data = await api('/logs');
  logsData = data?.logs || [];
  renderLogsTable();
}

function renderLogsTable() {
  const tbody = $('#logs-tbody');
  const empty = $('#logs-empty');
  const table = $('#logs-table');
  if (!tbody) return;

  const level = state.logsFilterLevel || 'all';
  const filtered = level === 'all' ? logsData : logsData.filter(l => l.level === level);

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    if (table) table.style.display = 'none';
    return;
  }

  if (empty) empty.classList.add('hidden');
  if (table) table.style.display = '';

  tbody.innerHTML = filtered.map(l => {
    const levelClass = 'logs-level--' + (l.level || 'info');
    const time = l.time ? new Date(l.time).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '-';
    return '<tr>' +
      '<td><span class="logs-time">' + escHtml(time) + '</span></td>' +
      '<td><span class="logs-level ' + levelClass + '">' + escHtml(l.level || '') + '</span></td>' +
      '<td><span class="logs-msg">' + escHtml(l.msg || '') + '</span></td>' +
      '</tr>';
  }).join('');
}

/* ─── Chat Page ──────────────────────────────────────────────── */
async function initChat() {
  clearPageRefresh();
  state.chatSelectedNumber = null;

  const refreshBtn = $('#refresh-btn');
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      refreshBtn.classList.add('spinning');
      await Promise.all([fetchContacts(), fetchChatContext(state.chatSelectedNumber)]);
      refreshBtn.classList.remove('spinning');
    };
  }

  await fetchContacts();
}

/* ─── Friend Memory ───────────────────────────────────────────── */
async function fetchFriendMemory(number) {
  if (!number) return null;
  return await api('/friends/' + encodeURIComponent(number) + '/memory');
}

function renderFriendMemory(memory, number, contacts) {
  const moodFacts = $('#chat-mood-facts');
  const memoryName = $('#chat-memory-name');
  const moodSection = $('#chat-mood-section');
  const factsSection = $('#chat-facts-section');
  const actionsEl = $('#chat-memory-actions');
  const resetBtn = $('#chat-memory-reset-btn');
  if (!moodFacts || !memoryName || !moodSection || !factsSection || !actionsEl) return;

  const contact = contacts ? contacts.find(c => c.number === number) : null;
  memoryName.textContent = contact?.name || number || '...';

  if (!memory) {
    moodFacts.classList.add('hidden');
    return;
  }

  moodFacts.classList.remove('hidden');

  const mem = memory || { facts: [], mood: null };
  const facts = Array.isArray(mem.facts) ? mem.facts : [];
  const moodText = mem.mood || null;

  // Mood section
  if (moodText) {
    moodSection.innerHTML =
      '<h4>Mood</h4>' +
      '<div class="chat-mood-label">' + escHtml(moodText) + '</div>' +
      (mem.moodUpdatedAt ? '<div class="chat-mood-score">' + new Date(mem.moodUpdatedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + '</div>' : '');
  } else {
    moodSection.innerHTML = '<div class="chat-mood-score" style="margin-bottom:0.5rem;">Belum ada mood</div>';
  }

  // Facts section
  if (facts.length > 0) {
    factsSection.innerHTML =
      '<h4>Facts</h4>' +
      facts.map((f, i) =>
        '<div class="chat-fact-item">' +
        '<span>' + escHtml(f) + '</span>' +
        '<button class="btn-tiny chat-fact-delete" data-index="' + i + '" data-number="' + escHtml(number) + '" title="Hapus fact">&#x2715;</button>' +
        '</div>'
      ).join('');
  } else {
    factsSection.innerHTML = '<div class="chat-mood-score" style="margin-bottom:0.5rem;">Belum ada facts</div>';
  }

  // Actions
  actionsEl.classList.remove('hidden');
  if (resetBtn) {
    resetBtn.onclick = async () => {
      resetBtn.textContent = '...';
      resetBtn.disabled = true;
      await api('/friends/' + encodeURIComponent(number) + '/memory', { method: 'DELETE' });
      toast('Memory direset');
      resetBtn.textContent = 'Reset Memory';
      resetBtn.disabled = false;
      // Reload
      const freshMem = await fetchFriendMemory(number);
      renderFriendMemory(freshMem, number, contacts);
    };
  }

  // Per-fact delete
  factsSection.querySelectorAll('.chat-fact-delete').forEach(btn => {
    btn.onclick = async () => {
      const idx = parseInt(btn.getAttribute('data-index'), 10);
      const num = btn.getAttribute('data-number');
      const remaining = facts.filter((_, i) => i !== idx);
      await api('/friends/' + encodeURIComponent(num) + '/memory', {
        method: 'PUT',
        body: JSON.stringify({ facts: remaining })
      });
      toast('Fact dihapus');
      const freshMem = await fetchFriendMemory(num);
      renderFriendMemory(freshMem, num, contacts);
    };
  });
}

async function fetchContacts() {
  const data = await api('/chat/contacts');
  const contacts = data?.contacts || [];
  state._contacts = contacts;
  renderContacts(contacts);
}

async function fetchChatContext(number) {
  if (!number) return;
  const [data, memoryData] = await Promise.all([
    api('/chat/context?number=' + encodeURIComponent(number)),
    fetchFriendMemory(number)
  ]);
  renderChatContext(data, number);
  renderFriendMemory(memoryData, number, state._contacts);
}

function renderContacts(contacts) {
  const list = $('#chat-contact-list');
  const count = $('#chat-count');
  if (!list) return;

  if (count) count.textContent = String(contacts.length);

  if (contacts.length === 0) {
    list.innerHTML = '<div class="empty-panel">Belum ada kontak</div>';
    return;
  }

  list.innerHTML = contacts.map(c => {
    const initial = (c.name || c.number || '?')[0].toUpperCase();
    const moodLabel = c.mood?.label || '---';
    const activeClass = state.chatSelectedNumber === c.number ? ' active' : '';
    return '<div class="chat-contact-item' + activeClass + '" data-number="' + escHtml(c.number) + '">' +
      '<div class="chat-contact-avatar">' + escHtml(initial) + '</div>' +
      '<div class="chat-contact-info">' +
      '<div class="chat-contact-name">' + escHtml(c.name || c.number) + '</div>' +
      '<div class="chat-contact-meta">' +
      '<span class="chat-contact-mood">' + escHtml(moodLabel) + '</span>' +
      '<span class="chat-contact-count">' + (c.msgCount || 0) + ' msg</span>' +
      '</div>' +
      '</div>' +
      '<span class="chat-contact-arrow">&rarr;</span>' +
      '</div>';
  }).join('');

  // Click handler via delegation
  list.onclick = (e) => {
    const item = e.target.closest('.chat-contact-item');
    if (!item) return;
    const number = item.getAttribute('data-number');
    if (!number) return;

    // Update active state
    list.querySelectorAll('.chat-contact-item').forEach(el => el.classList.remove('active'));
    item.classList.add('active');

    state.chatSelectedNumber = number;
    const contact = contacts.find(c => c.number === number);
    const nameBadge = $('#chat-contact-name-badge');
    if (nameBadge) nameBadge.textContent = (contact?.name || number) + ' \u2022 ' + (contact?.msgCount || 0) + ' msg';

    fetchChatContext(number);
  };
}

function renderChatContext(data, number) {
  const empty = $('#chat-empty');
  const list = $('#chat-messages-list');
  const moodFacts = $('#chat-mood-facts');
  const title = $('#chat-context-title');
  if (!list || !empty) return;

  const context = data?.context || [];

  if (context.length === 0) {
    empty.classList.remove('hidden');
    list.classList.add('hidden');
    if (moodFacts) moodFacts.classList.add('hidden');
    if (title) title.textContent = 'Percakapan (kosong)';
    return;
  }

  empty.classList.add('hidden');
  list.classList.remove('hidden');

  // Show last 30 messages
  const messages = context.slice(-30);
  if (title) title.textContent = 'Percakapan (' + messages.length + ' pesan)';

  list.innerHTML = messages.map(m => {
    const senderClass = m.sender === 'user' ? ' user' : '';
    const time = m.timestamp ? new Date(m.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '';
    return '<div class="chat-bubble">' +
      '<div class="chat-bubble-sender' + senderClass + '">' + escHtml(m.sender || 'system') + '</div>' +
      '<div class="chat-bubble-text">' + escHtml(m.text || '') + '</div>' +
      '<div class="chat-bubble-time">' + escHtml(time) + '</div>' +
      '</div>';
  }).join('');

  // Mood & facts
  if (moodFacts) {
    const moodData = data?.mood;
    const factsData = data?.facts || [];
    const hasMood = moodData && moodData.label;

    if (hasMood || factsData.length > 0) {
      moodFacts.classList.remove('hidden');
      const moodSection = $('#chat-mood-section');
      const factsSection = $('#chat-facts-section');

      if (moodSection) {
        if (hasMood) {
          moodSection.innerHTML =
            '<h4>Mood</h4>' +
            '<div class="chat-mood-label">' + escHtml(moodData.label) + '</div>' +
            '<div class="chat-mood-score">Score: ' + (moodData.score ?? '-') + '</div>';
        } else {
          moodSection.innerHTML = '';
        }
      }

      if (factsSection) {
        if (factsData.length > 0) {
          factsSection.innerHTML =
            '<h4>Facts</h4>' +
            factsData.map(f => '<div class="chat-fact-item">' + escHtml(f) + '</div>').join('');
        } else {
          factsSection.innerHTML = '';
        }
      }
    } else {
      moodFacts.classList.add('hidden');
    }
  }

  // Scroll messages list to bottom
  list.scrollTop = list.scrollHeight;
}

/* ─── Debug Page ─────────────────────────────────────────────── */
async function initDebug() {
  clearPageRefresh();
  setPageRefresh(fetchDebug, 15000);

  await fetchDebug();

  const refreshBtn = $('#refresh-btn');
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      refreshBtn.classList.add('spinning');
      await fetchDebug();
      refreshBtn.classList.remove('spinning');
    };
  }

  // Reset circuit breaker button
  const resetBtn = $('#debug-reset-cb');
  if (resetBtn) {
    resetBtn.onclick = async () => {
      resetBtn.classList.add('spinning');
      await api('/debug/reset-cb', { method: 'POST' });
      resetBtn.classList.remove('spinning');
      toast('Circuit breaker reset');
      await fetchDebug();
    };
  }
}

async function fetchDebug() {
  const data = await api('/debug');
  if (!data) {
    const err = $('#debug-error');
    if (err) err.style.display = '';
    return;
  }

  const err = $('#debug-error');
  if (err) err.style.display = 'none';

  // Circuit Breaker
  const cb = data.circuitBreaker || {};
  const cbStatus = $('#debug-cb-status');
  const cbMeta = $('#debug-cb-meta');
  if (cbStatus) {
    const status = (cb.status || 'unknown').toLowerCase();
    if (status === 'normal' || status === 'closed') {
      cbStatus.innerHTML = '<span class="debug-status debug-status--connected"><span class="debug-status-dot"></span> NORMAL</span>';
    } else if (status === 'open' || status === 'tripped') {
      cbStatus.innerHTML = '<span class="debug-status debug-status--disconnected"><span class="debug-status-dot"></span> OPEN</span>';
    } else {
      cbStatus.innerHTML = '<span class="debug-status debug-status--disconnected"><span class="debug-status-dot"></span> ' + escHtml(status.toUpperCase()) + '</span>';
    }
  }
  if (cbMeta) cbMeta.textContent = 'Threshold: ' + (cb.threshold ?? '-') + ' \u00B7 Cooldown: ' + formatMs(cb.cooldownMs ?? '-');

  // Redis
  const redisEl = $('#debug-redis');
  if (redisEl) {
    const connected = data.redis === 'connected';
    redisEl.innerHTML = '<span class="debug-status ' + (connected ? 'debug-status--connected' : 'debug-status--disconnected') + '"><span class="debug-status-dot"></span> ' + (connected ? 'CONNECTED' : 'DISCONNECTED') + '</span>';
  }

  // Ollama
  const ollamaModel = $('#debug-ollama-model');
  const ollamaTimeout = $('#debug-ollama-timeout');
  if (ollamaModel) ollamaModel.textContent = data.ollama?.model || '---';
  if (ollamaTimeout) ollamaTimeout.textContent = 'Timeout: ' + (data.ollama?.timeout ? data.ollama.timeout + 'ms' : '---');

  // Uptime
  const uptimeServer = $('#debug-uptime-server');
  const uptimeSession = $('#debug-uptime-session');
  if (uptimeServer) uptimeServer.textContent = data.uptime?.server ? fmtUptime(data.uptime.server) : '---';
  if (uptimeSession) uptimeSession.textContent = 'Session: ' + (data.uptime?.session ? fmtUptime(data.uptime.session) : '---');

  // Auto-Chat
  const autoChat = $('#debug-autochat');
  if (autoChat) {
    const ac = data.autoChat;
    autoChat.innerHTML = '<span class="debug-status ' + (ac ? 'debug-status--connected' : 'debug-status--disconnected') + '"><span class="debug-status-dot"></span> ' + (ac ? 'ACTIVE' : 'INACTIVE') + '</span>';
  }

  // Errors Today
  const errorsToday = $('#debug-errors-today');
  if (errorsToday) errorsToday.textContent = String(data.errorsToday ?? 0);
}

/* ─── Analytics Page ─────────────────────────────────────────── */
async function initAnalytics() {
  clearPageRefresh();

  let currentRange = '7d';

  // Range buttons
  const rangeBtns = document.querySelectorAll('.analytics-range-btn');
  rangeBtns.forEach(btn => {
    btn.onclick = () => {
      rangeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = btn.getAttribute('data-range') || '7d';
      fetchAnalytics(currentRange);
    };
  });

  // Manual refresh
  const refreshBtn = $('#refresh-btn');
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      refreshBtn.classList.add('spinning');
      await fetchAnalytics(currentRange);
      refreshBtn.classList.remove('spinning');
    };
  }

  await fetchAnalytics(currentRange);
}

async function fetchAnalytics(range) {
  const [trend, topFriends, hourly] = await Promise.all([
    api('/analytics/trend?range=' + encodeURIComponent(range)),
    api('/analytics/top-friends'),
    api('/analytics/hourly')
  ]);

  renderTrendChart(trend);
  renderTopFriendsChart(topFriends);
  renderHourlyChart(hourly);
}

function renderTrendChart(data) {
  const canvas = $('#analytics-trend-chart');
  if (!canvas || !window.Chart) return;

  if (state.charts.analyticsTrend) state.charts.analyticsTrend.destroy();

  const days = data?.days || [];
  const labels = days.length ? days.map(d => {
    const parts = d.date.split('-');
    return parts[2] + '/' + parts[1];
  }) : [];
  const sent = days.map(d => d.sent || 0);
  const received = days.map(d => d.received || 0);
  const tokens = days.map(d => Math.round((d.tokens || 0) / 1000));

  state.charts.analyticsTrend = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: labels.length ? labels : ['Data'],
      datasets: [
        {
          label: 'Terkirim',
          data: sent.length ? sent : [0],
          borderColor: '#000',
          backgroundColor: 'rgba(0,0,0,0.06)',
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: '#000',
          borderWidth: 2
        },
        {
          label: 'Diterima',
          data: received.length ? received : [0],
          borderColor: '#666',
          backgroundColor: 'rgba(0,0,0,0.03)',
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: '#666',
          borderWidth: 2,
          borderDash: [4, 4]
        },
        {
          label: 'Token (ribuan)',
          data: tokens.length ? tokens : [0],
          borderColor: '#999',
          backgroundColor: 'transparent',
          tension: 0.4,
          pointRadius: 2,
          pointBackgroundColor: '#999',
          borderWidth: 1.5,
          borderDash: [2, 4],
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: { font: { family: 'Inter, sans-serif', size: 11 }, boxWidth: 12, usePointStyle: true }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(0,0,0,0.06)', drawTicks: false },
          ticks: { font: { family: 'Inter, sans-serif', size: 10 } }
        },
        y: {
          grid: { color: 'rgba(0,0,0,0.06)', drawTicks: false },
          ticks: { font: { family: 'Inter, sans-serif', size: 10 }, maxTicksLimit: 6 }
        },
        y1: {
          position: 'right',
          grid: { display: false },
          ticks: { font: { family: 'Inter, sans-serif', size: 9 }, maxTicksLimit: 5 }
        }
      },
      interaction: { intersect: false, mode: 'index' }
    }
  });
}

function renderTopFriendsChart(data) {
  const canvas = $('#analytics-top-chart');
  if (!canvas || !window.Chart) return;

  if (state.charts.analyticsTop) state.charts.analyticsTop.destroy();

  const friends = data?.topFriends || [];
  const labels = friends.map(f => f.name || '?');
  const counts = friends.map(f => f.msgCount || 0);
  const pcts = friends.map(f => f.percentage || 0);

  if (labels.length === 0) {
    labels.push('Belum ada data');
    counts.push(0);
  }

  state.charts.analyticsTop = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Pesan',
        data: counts,
        backgroundColor: labels.map((_, i) => i === 0 && !friends.length ? 'rgba(0,0,0,0.06)' : 'rgba(0,0,0,0.85)'),
        borderColor: labels.map((_, i) => i === 0 && !friends.length ? '#ccc' : '#000'),
        borderWidth: 2,
        borderRadius: 0,
        barThickness: 20
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: function(context) {
              const pct = pcts[context.dataIndex];
              return pct ? pct + '% of total' : '';
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(0,0,0,0.06)', drawTicks: false },
          ticks: { font: { family: 'Inter, sans-serif', size: 9 }, maxTicksLimit: 5 }
        },
        y: {
          grid: { display: false },
          ticks: { font: { family: 'Inter, sans-serif', size: 9 } }
        }
      }
    }
  });
}

function renderHourlyChart(data) {
  const canvas = $('#analytics-hourly-chart');
  if (!canvas || !window.Chart) return;

  if (state.charts.analyticsHourly) state.charts.analyticsHourly.destroy();

  const hours = data?.hours || [];
  const labels = hours.map(h => String(h.hour || 0).padStart(2, '0') + ':00');
  const counts = hours.map(h => h.count || 0);

  if (labels.length === 0) {
    for (let i = 0; i < 24; i++) {
      labels.push(String(i).padStart(2, '0') + ':00');
      counts.push(0);
    }
  }

  state.charts.analyticsHourly = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Pesan',
        data: counts,
        backgroundColor: 'rgba(0,0,0,0.8)',
        borderColor: '#000',
        borderWidth: 1.5,
        borderRadius: 0,
        barThickness: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { family: 'Inter, sans-serif', size: 8 }, maxTicksLimit: 12 }
        },
        y: {
          grid: { color: 'rgba(0,0,0,0.06)', drawTicks: false },
          ticks: { font: { family: 'Inter, sans-serif', size: 9 }, maxTicksLimit: 5 }
        }
      }
    }
  });
}

/* ─── Utility functions ─────────────────────────────────────── */
function escHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

function formatMs(ms) {
  if (ms == null || ms === '-') return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + 'm ' + r + 's';
}

function fmtNum(n) {
  if (n == null) return '0';
  return Number(n).toLocaleString('id-ID');
}

function fmtUptime(s) {
  if (!s || s <= 0) return '0m';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + 'j ' + m + 'm';
  return m + 'm';
}

function deltaStr(d) {
  if (!d || d.pct == null) return '-';
  const sign = d.direction > 0 ? '+' : '';
  return sign + d.pct + '%';
}

/* ─── Init ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {

  // Login form
  const loginForm = $('#login-form');
  if (loginForm) {
    loginForm.onsubmit = (e) => {
      e.preventDefault();
      const pw = $('#login-password');
      if (pw && pw.value.trim()) handleLogin(pw.value.trim());
    };
  }

  // Sidebar nav clicks (delegated)
  const sidebarNav = $('#sidebar-nav');
  if (sidebarNav) {
    sidebarNav.onclick = (e) => {
      const link = e.target.closest('a');
      if (link) {
        const href = link.getAttribute('href');
        if (href && href.startsWith('#')) {
          e.preventDefault();
          location.hash = href;
          // Close sidebar on mobile after navigation
          const sidebar = $('#sidebar');
          const overlay = $('#sidebar-overlay');
          if (sidebar) sidebar.classList.remove('open');
          if (overlay) overlay.classList.remove('active');
        }
      }
    };
  }

  // Logout button
  const logoutBtn = $('#logout-btn');
  if (logoutBtn) logoutBtn.onclick = handleLogout;

  // Sidebar toggle (mobile)
  const toggleBtn = $('#sidebar-toggle');
  const sidebar = $('#sidebar');
  const overlay = $('#sidebar-overlay');
  if (toggleBtn && sidebar) {
    const toggleSidebar = () => {
      sidebar.classList.toggle('open');
      if (overlay) overlay.classList.toggle('active');
    };
    toggleBtn.onclick = toggleSidebar;
    if (overlay) overlay.onclick = toggleSidebar;
  }

  // Hash change
  window.addEventListener('hashchange', router);

  // Initial route
  router();
});


