import { join } from 'path';
import { app } from 'electron';
import fs from 'fs';
import log from 'electron-log';

export interface HeartbeatPayload {
  appName: string;
  windowTitle: string;
  isIdle: boolean;
  isSynthetic: boolean;
  mouseEvents: number;
  keyEvents: number;
  timestamp: string;
}

function getJsonBufferPath(): string {
  const userData = app.getPath('userData');
  return join(userData, 'offline_buffer.json');
}

function readBuffer(): (HeartbeatPayload & { id: number })[] {
  try {
    const p = getJsonBufferPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  } catch (err) {
    log.error('Failed to read offline buffer:', err);
  }
  return [];
}

function writeBuffer(data: (HeartbeatPayload & { id: number })[]): void {
  try {
    fs.writeFileSync(getJsonBufferPath(), JSON.stringify(data, null, 2));
  } catch (err) {
    log.error('Failed to write offline buffer:', err);
  }
}

export function initDatabase(): void {
  const p = getJsonBufferPath();
  if (!fs.existsSync(p)) {
    writeBuffer([]);
  }
  log.info('Offline JSON buffer initialized at:', p);
}

export function saveOfflineHeartbeat(payload: HeartbeatPayload): void {
  const data = readBuffer();
  const nextId = data.length > 0 ? Math.max(...data.map(d => d.id)) + 1 : 1;
  data.push({
    id: nextId,
    ...payload
  });
  writeBuffer(data);
  log.info('Saved heartbeat to offline buffer:', payload.timestamp);
}

export function getOfflineHeartbeats(): (HeartbeatPayload & { id: number })[] {
  return readBuffer();
}

export function deleteOfflineHeartbeat(id: number): void {
  let data = readBuffer();
  data = data.filter(item => item.id !== id);
  writeBuffer(data);
  log.info(`Deleted offline heartbeat ID ${id} from buffer`);
}

export function getOfflineCount(): number {
  return readBuffer().length;
}
