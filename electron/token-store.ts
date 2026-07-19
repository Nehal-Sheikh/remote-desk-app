import { app } from 'electron';
import { join } from 'path';
import fs from 'fs';
import log from 'electron-log';

function getTokenPath(): string {
  const userData = app.getPath('userData');
  return join(userData, 'token_store.json');
}

export async function storeTokens(accessToken: string, refreshToken?: string): Promise<void> {
  try {
    const p = getTokenPath();
    let currentData: any = {};
    if (fs.existsSync(p)) {
      try {
        currentData = JSON.parse(fs.readFileSync(p, 'utf-8'));
      } catch {
        // Ignore JSON parse errors
      }
    }
    const data = {
      ...currentData,
      accessToken,
      token: accessToken, // for legacy compatibility
      refreshToken: refreshToken || currentData.refreshToken || ''
    };
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    log.info('Tokens stored successfully.');
  } catch (err) {
    log.error('Failed to store tokens:', err);
  }
}

export async function getStoredToken(): Promise<string | null> {
  try {
    const p = getTokenPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return data.accessToken || data.token || null;
    }
  } catch (err) {
    log.error('Failed to read token:', err);
  }
  return null;
}

export async function getStoredRefreshToken(): Promise<string | null> {
  try {
    const p = getTokenPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return data.refreshToken || null;
    }
  } catch (err) {
    log.error('Failed to read refresh token:', err);
  }
  return null;
}

export async function clearToken(): Promise<void> {
  try {
    const p = getTokenPath();
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
    log.info('Tokens cleared successfully.');
  } catch (err) {
    log.error('Failed to clear token:', err);
  }
}
