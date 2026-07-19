import { app } from 'electron';
import { join } from 'path';
import fs from 'fs';
import log from 'electron-log';

let keytar: any = null;
try {
  keytar = require('keytar');
} catch (e) {
  log.warn('keytar native module not compiled. Using local file fallback for credentials.');
}

const SERVICE = 'RemoteDeskAgent';
const ACCOUNT = 'access-token';

// Simple file-based fallback storage for local development/testing when native modules aren't compiled
function getFallbackPath(): string {
  const userData = app.getPath('userData');
  return join(userData, 'token_fallback.json');
}

function writeFallback(token: string): void {
  try {
    fs.writeFileSync(getFallbackPath(), JSON.stringify({ token }));
  } catch (err) {
    log.error('Failed to write fallback token', err);
  }
}

function readFallback(): string | null {
  try {
    const p = getFallbackPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return data.token || null;
    }
  } catch (err) {
    log.error('Failed to read fallback token', err);
  }
  return null;
}

function clearFallback(): void {
  try {
    const p = getFallbackPath();
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch (err) {}
}

export async function storeToken(token: string): Promise<void> {
  if (keytar) {
    try {
      await keytar.setPassword(SERVICE, ACCOUNT, token);
      return;
    } catch (err) {
      log.error('keytar failed, falling back to file:', err);
    }
  }
  writeFallback(token);
}

export async function getStoredToken(): Promise<string | null> {
  if (keytar) {
    try {
      return await keytar.getPassword(SERVICE, ACCOUNT);
    } catch (err) {
      log.error('keytar failed, falling back to file:', err);
    }
  }
  return readFallback();
}

export async function clearToken(): Promise<void> {
  if (keytar) {
    try {
      await keytar.deletePassword(SERVICE, ACCOUNT);
      return;
    } catch (err) {
      log.error('keytar failed, falling back to file:', err);
    }
  }
  clearFallback();
}
