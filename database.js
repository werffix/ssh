const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'ssh.db');

let db;

function initDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER DEFAULT 22,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function getServers() {
  return db.prepare('SELECT id, name, host, port, username, password, created_at FROM servers ORDER BY created_at DESC').all();
}

function getServer(id) {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
}

function createServer(name, host, port, username, password) {
  const result = db.prepare(
    'INSERT INTO servers (name, host, port, username, password) VALUES (?, ?, ?, ?, ?)'
  ).run(name, host, port, username, password);
  return result.lastInsertRowid;
}

function updateServer(id, name, host, port, username, password) {
  if (password) {
    db.prepare(
      'UPDATE servers SET name = ?, host = ?, port = ?, username = ?, password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(name, host, port, username, password, id);
  } else {
    db.prepare(
      'UPDATE servers SET name = ?, host = ?, port = ?, username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(name, host, port, username, id);
  }
}

function deleteServer(id) {
  db.prepare('DELETE FROM servers WHERE id = ?').run(id);
}

module.exports = { initDB, getServers, getServer, createServer, updateServer, deleteServer };
