import { join } from 'path';
import { app } from 'electron';
import fs from 'fs';
import log from 'electron-log';

let Database: any = null;
let db: any = null;
let isSqliteAvailable = false;

try {
  Database = require('better-sqlite3');
  isSqliteAvailable = true;
} catch (e) {
  log.warn('better-sqlite3 native module not compiled. Using local JSON file fallback for offline queue.');
}

export interface HeartbeatPayload {
  appName: string;
  windowTitle: string;
  isIdle: boolean;
  isSynthetic: boolean;
  mouseEvents: number;
  keyEvents: number;
  timestamp: string;
}

// Fallback JSON file path
function getJsonFallbackPath(): string {
  const userData = app.getPath('userData');
  return join(userData, 'offline_buffer_fallback.json');
}

function readJsonFallback(): (HeartbeatPayload & { id: number })[] {
  try {
    const p = getJsonFallbackPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch (err) {
    log.error('Failed to read JSON offline buffer:', err);
  }
  return [];
}

function writeJsonFallback(data: (HeartbeatPayload & { id: number })[]): void {
  try {
    fs.writeFileSync(getJsonFallbackPath(), JSON.stringify(data, null, 2));
  } catch (err) {
    log.error('Failed to write JSON offline buffer:', err);
  }
}

export function initDatabase(): void {
  if (isSqliteAvailable) {
    try {
      const userDataPath = app.getPath('userData');
      const dbPath = join(userDataPath, 'offline_buffer.db');
      db = new Database(dbPath);
      
      db.prepare(`
        CREATE TABLE IF NOT EXISTS pending_heartbeats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          appName TEXT,
          windowTitle TEXT,
          isIdle INTEGER,
          isSynthetic INTEGER,
          mouseEvents INTEGER,
          keyEvents INTEGER,
          timestamp TEXT
        )
      `).run();
      
      log.info('Offline SQLite Database initialized at:', dbPath);
      return;
    } catch (err) {
      log.error('Failed to initialize SQLite database, switching to JSON file mode:', err);
      isSqliteAvailable = false;
    }
  }
  
  // JSON initialization
  const p = getJsonFallbackPath();
  if (!fs.existsSync(p)) {
    writeJsonFallback([]);
  }
  log.info('Offline JSON buffer initialized at:', p);
}

export function saveOfflineHeartbeat(payload: HeartbeatPayload): void {
  if (isSqliteAvailable && db) {
    try {
      const insert = db.prepare(`
        INSERT INTO pending_heartbeats 
        (appName, windowTitle, isIdle, isSynthetic, mouseEvents, keyEvents, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      
      insert.run(
        payload.appName,
        payload.windowTitle,
        payload.isIdle ? 1 : 0,
        payload.isSynthetic ? 1 : 0,
        payload.mouseEvents,
        payload.keyEvents,
        payload.timestamp
      );
      log.info('Saved heartbeat to SQLite offline buffer:', payload.timestamp);
      return;
    } catch (err) {
      log.error('SQLite save failed, falling back to JSON:', err);
    }
  }

  // JSON fallback save
  const data = readJsonFallback();
  const nextId = data.length > 0 ? Math.max(...data.map(d => d.id)) + 1 : 1;
  data.push({
    id: nextId,
    ...payload
  });
  writeJsonFallback(data);
  log.info('Saved heartbeat to JSON offline buffer:', payload.timestamp);
}

export function getOfflineHeartbeats(): (HeartbeatPayload & { id: number })[] {
  if (isSqliteAvailable && db) {
    try {
      const rows = db.prepare('SELECT * FROM pending_heartbeats ORDER BY id ASC').all();
      return rows.map((row: any) => ({
        id: row.id,
        appName: row.appName,
        windowTitle: row.windowTitle,
        isIdle: row.isIdle === 1,
        isSynthetic: row.isSynthetic === 1,
        mouseEvents: row.mouseEvents,
        keyEvents: row.keyEvents,
        timestamp: row.timestamp
      }));
    } catch (err) {
      log.error('SQLite read failed, falling back to JSON:', err);
    }
  }

  return readJsonFallback();
}

export function deleteOfflineHeartbeat(id: number): void {
  if (isSqliteAvailable && db) {
    try {
      db.prepare('DELETE FROM pending_heartbeats WHERE id = ?').run(id);
      log.info(`Deleted offline heartbeat ID ${id} from SQLite`);
      return;
    } catch (err) {
      log.error('SQLite delete failed, falling back to JSON:', err);
    }
  }

  // JSON fallback delete
  let data = readJsonFallback();
  data = data.filter(item => item.id !== id);
  writeJsonFallback(data);
  log.info(`Deleted offline heartbeat ID ${id} from JSON`);
}

export function getOfflineCount(): number {
  if (isSqliteAvailable && db) {
    try {
      const result = db.prepare('SELECT COUNT(*) as count FROM pending_heartbeats').get() as { count: number };
      return result.count;
    } catch (err) {
      // Fallback
    }
  }

  return readJsonFallback().length;
}
