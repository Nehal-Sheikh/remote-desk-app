import { app } from 'electron';
import { join } from 'path';
import fs from 'fs';
import log from 'electron-log';

function getTokenPath(): string {
  const userData = app.getPath('userData');
  return join(userData, 'token_store.json');
}

export async function storeToken(token: string): Promise<void> {
  try {
    fs.writeFileSync(getTokenPath(), JSON.stringify({ token }));
  } catch (err) {
    log.error('Failed to store token:', err);
  }
}

export async function getStoredToken(): Promise<string | null> {
  try {
    const p = getTokenPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return data.token || null;
    }
  } catch (err) {
    log.error('Failed to read token:', err);
  }
  return null;
}

export async function clearToken(): Promise<void> {
  try {
    const p = getTokenPath();
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch (err) {
    log.error('Failed to clear token:', err);
  }
}
