const API = '/api';
let accessKey = localStorage.getItem('ssh_access_key') || '';
let currentServerId = null;
let currentServerName = '';
let term = null;
let fitAddon = null;
let ws = null;
let connected = false;

// Init
document.addEventListener('DOMContentLoaded', () => {
  if (accessKey) {
    showView('menu');
  }
  document.getElementById('access-key').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAuth();
  });
  document.getElementById('quick-command').addEventListener('keydown', e => {
    if (e.key === 'Enter' && connected) {
      const val = e.target.value;
      if (val && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'input', data: val + '\n' }));
        e.target.value = '';
      }
    }
  });
});

// View
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + id).classList.add('active');
  if (id === 'servers' || id === 'connect') loadServersList();
}

// Auth
async function handleAuth() {
  const key = document.getElementById('access-key').value;
  if (!key) return;
  try {
    const res = await fetch(API + '/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();
    if (data.ok) {
      accessKey = key;
      localStorage.setItem('ssh_access_key', key);
      document.getElementById('auth-error').textContent = '';
      showView('menu');
    } else {
      document.getElementById('auth-error').textContent = data.error || 'Invalid key';
    }
  } catch (e) {
    document.getElementById('auth-error').textContent = 'Connection error';
  }
}

// API helper
async function api(path, options = {}) {
  const headers = { 'X-Access-Key': accessKey, ...options.headers };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(API + path, { ...options, headers });
  return res.json();
}

// Servers
async function loadServersList() {
  const data = await api('/servers');
  const list = document.getElementById('servers-list');
  const connect = document.getElementById('connect-list');
  if (!Array.isArray(data)) return;
  localStorage.setItem('_servers_cache', JSON.stringify(data));
  
  list.innerHTML = data.length ? data.map(s => `
    <div class="server-card">
      <div class="server-info">
        <div class="server-name">${esc(s.name)}</div>
        <div class="server-host">${esc(s.username)}@${esc(s.host)}:${s.port}</div>
      </div>
      <div class="server-actions">
        <button class="btn-edit" onclick="editServer(${s.id})">EDIT</button>
        <button class="btn-delete" onclick="deleteServer(${s.id})">DEL</button>
      </div>
    </div>
  `).join('') : '<div class="empty-state">No servers yet</div>';
  
  connect.innerHTML = data.length ? data.map(s => `
    <div class="server-card">
      <div class="server-info">
        <div class="server-name">${esc(s.name)}</div>
        <div class="server-host">${esc(s.username)}@${esc(s.host)}:${s.port}</div>
      </div>
      <div class="server-actions">
        <button class="btn-connect" onclick="connectToServer(${s.id}, '${esc(s.name)}')">CONNECT</button>
      </div>
    </div>
  `).join('') : '<div class="empty-state">No servers available</div>';
}

async function handleAddServer(e) {
  e.preventDefault();
  const form = e.target;
  const data = {
    name: form.name.value,
    host: form.host.value,
    port: parseInt(form.port.value) || 22,
    username: form.username.value,
    password: form.password.value
  };
  const res = await api('/servers', {
    method: 'POST',
    body: JSON.stringify(data)
  });
  if (res.ok) {
    form.reset();
    form.port.value = '22';
    showView('servers');
  } else {
    document.getElementById('add-error').textContent = res.error || 'Error';
  }
}

function editServer(id) {
  showView('edit-server');
  const all = JSON.parse(localStorage.getItem('_servers_cache') || '[]');
  const s = all.find(x => x.id === id);
  if (s) {
    document.getElementById('edit-id').value = s.id;
    document.getElementById('edit-name').value = s.name;
    document.getElementById('edit-host').value = s.host;
    document.getElementById('edit-username').value = s.username;
    document.getElementById('edit-port').value = s.port;
    document.getElementById('edit-password').value = '';
  }
}

async function handleEditServer(e) {
  e.preventDefault();
  const id = document.getElementById('edit-id').value;
  const data = {
    name: document.getElementById('edit-name').value,
    host: document.getElementById('edit-host').value,
    port: parseInt(document.getElementById('edit-port').value) || 22,
    username: document.getElementById('edit-username').value
  };
  const pw = document.getElementById('edit-password').value;
  if (pw) data.password = pw;
  const res = await api('/servers/' + id, { method: 'PUT', body: JSON.stringify(data) });
  if (res.ok) {
    showView('servers');
  } else {
    document.getElementById('edit-error').textContent = res.error || 'Error';
  }
}

async function deleteServer(id) {
  if (!confirm('Delete this server?')) return;
  await api('/servers/' + id, { method: 'DELETE' });
  loadServersList();
}

// Terminal
function connectToServer(id, name) {
  currentServerId = id;
  currentServerName = name;
  showView('terminal');
  document.getElementById('terminal-title').textContent = 'Connecting to ' + name + '...';
  setTerminalEnabled(false);
  initTerminal();
}

function initTerminal() {
  if (term) { term.dispose(); term = null; }
  
  const container = document.getElementById('terminal-container');
  fitAddon = new FitAddon();
  term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontSize: 14,
    fontFamily: "'Source Code Pro', 'Courier New', monospace",
    theme: {
      background: '#000',
      foreground: '#e0e0e0',
      cursor: '#fff',
      selectionBackground: '#333',
      black: '#000',
      brightBlack: '#333',
      white: '#e0e0e0',
      brightWhite: '#fff'
    },
    allowTransparency: false,
    scrollback: 5000,
    cols: 80,
    rows: 24
  });
  
  term.loadAddon(fitAddon);
  term.open(container);
  
  setTimeout(() => {
    try { fitAddon.fit(); } catch(_) {}
  }, 50);
  
  window._termResize = () => {
    try { fitAddon.fit(); } catch(_) {}
    if (ws && ws.readyState === 1) {
      const dims = fitAddon.proposeDimensions();
      if (dims) ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
    }
  };
  window.addEventListener('resize', window._termResize);
  
  term.onData(data => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });
  
  connectWebSocket();
}

function connectWebSocket() {
  if (ws) { ws.close(); ws = null; }
  
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host + '/ws/terminal?serverId=' + currentServerId + '&key=' + accessKey;
  
  ws = new WebSocket(url);
  
  ws.onopen = () => {
    document.getElementById('terminal-title').textContent = 'Connecting...';
  };
  
  ws.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'ready') {
        document.getElementById('terminal-title').textContent = 'Connected to ' + currentServerName;
        connected = true;
        setTerminalEnabled(true);
        setTimeout(() => {
          try {
            const dims = fitAddon.proposeDimensions();
            if (dims && ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
            }
          } catch(_) {}
        }, 100);
      } else if (msg.type === 'output') {
        if (term) term.write(msg.data);
      } else if (msg.type === 'error') {
        document.getElementById('terminal-title').textContent = 'Error: ' + msg.message;
        if (term) term.writeln('\r\n\x1b[1;37mError: ' + msg.message + '\x1b[0m');
        setTerminalEnabled(false);
        connected = false;
      } else if (msg.type === 'disconnect') {
        document.getElementById('terminal-title').textContent = 'Disconnected';
        if (term) term.writeln('\r\n\x1b[1;37mConnection closed\x1b[0m');
        setTerminalEnabled(false);
        connected = false;
      }
    } catch(_) {}
  };
  
  ws.onerror = () => {
    document.getElementById('terminal-title').textContent = 'Connection error';
    connected = false;
    setTerminalEnabled(false);
  };
  
  ws.onclose = () => {
    if (connected) {
      document.getElementById('terminal-title').textContent = 'Disconnected';
      connected = false;
      setTerminalEnabled(false);
    }
  };
}

function setTerminalEnabled(enabled) {
  document.getElementById('quick-command').disabled = !enabled;
  document.querySelectorAll('.quick-buttons button').forEach(b => {
    if (b.title !== 'Disconnect' && b.title !== 'Upload File') {
      // Only disable specific buttons based on connection
    }
  });
  // Properly enable/disable
  document.querySelectorAll('.quick-buttons button').forEach(b => {
    const t = b.title || '';
    if (t.includes('Ctrl') || t.includes('SIGINT') || t.includes('EOF')) {
      b.disabled = !enabled;
    }
  });
  // Upload button only enabled when connected
  document.querySelectorAll('.quick-buttons button').forEach(b => {
    if (b.title === 'Upload File') b.disabled = !enabled;
  });
}

function disconnectTerminal() {
  connected = false;
  if (ws) { ws.close(); ws = null; }
  if (term) { term.dispose(); term = null; }
  if (window._termResize) {
    window.removeEventListener('resize', window._termResize);
  }
  currentServerId = null;
  showView('menu');
}

function sendCtrlC() {
  if (ws && ws.readyState === 1 && connected) {
    ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
  }
}

function sendCtrlD() {
  if (ws && ws.readyState === 1 && connected) {
    ws.send(JSON.stringify({ type: 'input', data: '\x04' }));
  }
}

// Upload
function openUploadDialog() {
  document.getElementById('upload-modal').classList.add('active');
  document.getElementById('file-input').value = '';
  document.getElementById('upload-path').value = '~/';
  document.getElementById('upload-status').textContent = '';
}

function closeUploadDialog() {
  document.getElementById('upload-modal').classList.remove('active');
}

async function handleUpload() {
  const fileInput = document.getElementById('file-input');
  const pathInput = document.getElementById('upload-path');
  const status = document.getElementById('upload-status');
  
  if (!fileInput.files.length) {
    status.textContent = 'Select a file';
    return;
  }
  
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('path', pathInput.value || '~/');
  
  status.textContent = 'Uploading...';
  try {
    const res = await fetch(API + '/upload?serverId=' + currentServerId, {
      method: 'POST',
      headers: { 'X-Access-Key': accessKey },
      body: formData
    });
    const data = await res.json();
    if (data.ok) {
      status.textContent = 'Uploaded: ' + data.path;
      status.className = 'success';
      setTimeout(closeUploadDialog, 1500);
    } else {
      status.textContent = data.error || 'Upload failed';
    }
  } catch(e) {
    status.textContent = 'Upload error';
  }
}

// Utility
function esc(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
