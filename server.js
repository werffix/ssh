require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const db = require('./database');

db.initDB();

const app = express();
const server = http.createServer(app);

const ACCESS_KEY = process.env.ACCESS_KEY;
const PORT = process.env.PORT || 3000;

if (!ACCESS_KEY) {
  console.error('ACCESS_KEY not set in .env');
  process.exit(1);
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// --- Encryption ---
const ALGO = 'aes-256-cbc';
function encrypt(text) {
  const key = crypto.createHash('sha256').update(ACCESS_KEY).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return iv.toString('hex') + ':' + enc;
}
function decrypt(text) {
  const key = crypto.createHash('sha256').update(ACCESS_KEY).digest();
  const [iv, enc] = text.split(':');
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'hex'));
  let dec = decipher.update(enc, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

// --- Middleware ---
app.use(express.json());

function auth(req, res, next) {
  const key = req.headers['x-access-key'];
  if (key !== ACCESS_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// --- Auth ---
app.post('/api/auth', (req, res) => {
  if (req.body.key === ACCESS_KEY) return res.json({ ok: true });
  res.status(401).json({ error: 'Invalid key' });
});

// --- Server CRUD ---
app.get('/api/servers', auth, (req, res) => {
  const list = db.getServers();
  res.json(list.map(s => ({ ...s, password: decrypt(s.password) })));
});

app.post('/api/servers', auth, (req, res) => {
  const { name, host, port, username, password } = req.body;
  if (!name || !host || !username || !password) return res.status(400).json({ error: 'Missing fields' });
  const id = db.createServer(name, host, port || 22, username, encrypt(password));
  res.json({ ok: true, id });
});

app.put('/api/servers/:id', auth, (req, res) => {
  const { name, host, port, username, password } = req.body;
  db.updateServer(
    req.params.id, name, host, port || 22, username,
    password ? encrypt(password) : null
  );
  res.json({ ok: true });
});

app.delete('/api/servers/:id', auth, (req, res) => {
  db.deleteServer(req.params.id);
  res.json({ ok: true });
});

// --- File Upload via SFTP ---
app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
  const serverId = req.query.serverId;
  const destPath = req.body.path || '~';
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const srv = db.getServer(serverId);
  if (!srv) return res.status(404).json({ error: 'Server not found' });

  const password = decrypt(srv.password);
  const conn = new Client();

  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) { conn.end(); return res.status(500).json({ error: 'SFTP error: ' + err.message }); }
      const base = destPath === '~' ? '/home/' + srv.username : destPath;
      const remote = path.join(base, req.file.originalname);
      sftp.writeFile(remote, req.file.buffer, err => {
        sftp.end();
        conn.end();
        if (err) return res.status(500).json({ error: 'Upload failed: ' + err.message });
        res.json({ ok: true, path: remote });
      });
    });
  });

  conn.on('error', err => {
    res.status(500).json({ error: 'SSH error: ' + err.message });
  });

  conn.connect({
    host: srv.host, port: srv.port, username: srv.username, password,
    readyTimeout: 10000
  });
});

// --- WebSocket for SSH Terminal ---
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/ws/terminal') {
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const serverId = url.searchParams.get('serverId');
  const key = url.searchParams.get('key');

  if (key !== ACCESS_KEY || !serverId) {
    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
    return ws.close();
  }

  const srv = db.getServer(serverId);
  if (!srv) {
    ws.send(JSON.stringify({ type: 'error', message: 'Server not found' }));
    return ws.close();
  }

  const password = decrypt(srv.password);
  const conn = new Client();
  let stream = null;

  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, shell) => {
      if (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
        return ws.close();
      }
      stream = shell;
      ws.send(JSON.stringify({ type: 'ready' }));

      shell.on('data', data => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data: data.toString('utf-8') }));
      });
      shell.stderr.on('data', data => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data: data.toString('utf-8') }));
      });
      shell.on('close', () => {
        ws.send(JSON.stringify({ type: 'disconnect' }));
        ws.close();
      });
    });
  });

  conn.on('error', err => {
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    ws.close();
  });

  conn.on('close', () => {
    if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'disconnect' })); ws.close(); }
  });

  conn.connect({
    host: srv.host, port: srv.port, username: srv.username, password,
    readyTimeout: 10000
  });

  ws.on('message', data => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'input' && stream) stream.write(msg.data);
      if (msg.type === 'resize' && stream) stream.setWindow(msg.rows || 24, msg.cols || 80, 0, 0);
    } catch (_) {}
  });

  ws.on('close', () => {
    if (stream) stream.close();
    conn.end();
  });
});

// --- Static & SPA ---
app.use(express.static('public'));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log('SSH Terminal running on http://localhost:' + PORT);
});
