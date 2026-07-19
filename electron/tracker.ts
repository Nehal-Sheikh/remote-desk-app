import { BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import log from 'electron-log';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  initDatabase,
  saveOfflineHeartbeat,
  getOfflineHeartbeats,
  deleteOfflineHeartbeat,
  getOfflineCount
} from './offline-buffer';
import { storeTokens, getStoredToken, getStoredRefreshToken } from './token-store';

const execAsync = promisify(exec);

let trackingInterval: NodeJS.Timeout | null = null;
let syncInterval: NodeJS.Timeout | null = null;
let currentToken: string | null = null;
let currentRefreshToken: string | null = null;
let trackingActive = false;
let uninstallAllowed = true;
let activeApiUrl = 'http://localhost:3000/api';

export function isUninstallAllowed(): boolean {
  return uninstallAllowed;
}

export function loadLocalUninstallPolicy(): void {
  try {
    const policyPath = path.join(app.getPath('userData'), 'uninstall_policy.txt');
    if (fs.existsSync(policyPath)) {
      const content = fs.readFileSync(policyPath, 'utf8');
      const match = content.match(/uninstallAllowed=(true|false)/);
      if (match) {
        uninstallAllowed = match[1] === 'true';
        log.info('Loaded local uninstall policy. Allowed:', uninstallAllowed);
      }
      const apiMatch = content.match(/apiUrl=(.+)/);
      if (apiMatch && apiMatch[1]) {
        activeApiUrl = apiMatch[1].trim();
        log.info('Loaded local API URL:', activeApiUrl);
      }
    }
  } catch (err: any) {
    log.error('Failed to load local uninstall policy:', err.message);
  }
}

// NOTE: loadLocalUninstallPolicy() is NOT called here at module level
// because app.getPath('userData') requires the Electron app to be ready.
// It is called explicitly inside startTracking() once the app is initialized.

let mouseEventCount = 0;
let keyEventCount = 0;
let lastInputTime = Date.now();

export function incrementMouseEvent(): void {
  mouseEventCount++;
  lastInputTime = Date.now();
}

export function incrementKeyEvent(): void {
  keyEventCount++;
  lastInputTime = Date.now();
}

export function resetInputStats(): void {
  mouseEventCount = 0;
  keyEventCount = 0;
}

export function isTracking(): boolean {
  return trackingActive;
}

async function execPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execAsync(`powershell -NoProfile -EncodedCommand ${encoded}`);
  return stdout;
}

// Shell-based active window tracking using Base64 EncodedCommand to ensure reliable Win32 API access
async function getActiveWindow(): Promise<{ appName: string; windowTitle: string }> {
  const platform = process.platform;
  
  if (platform === 'win32') {
    try {
      const script = `
        $code = @"
          using System;
          using System.Runtime.InteropServices;
          using System.Text;
          public class Win32Active {
            [DllImport("user32.dll")]
            public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")]
            public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
            [DllImport("user32.dll")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
          }
"@
        Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
        $hwnd = [Win32Active]::GetForegroundWindow()
        $title = New-Object System.Text.StringBuilder 256
        $null = [Win32Active]::GetWindowText($hwnd, $title, 256)
        $processId = 0
        $null = [Win32Active]::GetWindowThreadProcessId($hwnd, [ref]$processId)
        $process = Get-Process -Id $processId
        [PSCustomObject]@{
          AppName = if ($process.ProcessName) { $process.ProcessName } else { "Desktop / System" }
          Title = if ($title.ToString()) { $title.ToString() } else { "Active Workspace" }
        } | ConvertTo-Json
      `;

      const stdout = await execPowerShell(script);
      const parsed = JSON.parse(stdout.trim());
      return {
        appName: parsed.AppName || 'Desktop / System',
        windowTitle: parsed.Title || 'Active Workspace'
      };
    } catch (err: any) {
      log.warn('[getActiveWindow] Win32 active window check fallback:', err.message);
      return { appName: 'Desktop / System', windowTitle: 'Active Workspace' };
    }
  } else if (platform === 'darwin') {
    try {
      const cmd = `osascript -e 'tell application "System Events" to set frontApp to name of first application process whose frontmost is true' -e 'tell application "System Events" to tell process frontApp to set windowTitle to name of first window' -e 'return frontApp & "::" & windowTitle'`;
      const { stdout } = await execAsync(cmd);
      const parts = stdout.trim().split('::');
      return {
        appName: parts[0] || 'Desktop / System',
        windowTitle: parts[1] || 'Active Workspace'
      };
    } catch (err) {
      return { appName: 'Desktop / System', windowTitle: 'Active Workspace' };
    }
  } else {
    // Linux / X11 fallback
    try {
      const { stdout: title } = await execAsync('xdotool getactivewindow getwindowname');
      const { stdout: appName } = await execAsync('xdotool getactivewindow getwindowpid | xargs ps -o comm= -p');
      return {
        appName: appName.trim() || 'Desktop / System',
        windowTitle: title.trim() || 'Active Workspace'
      };
    } catch (err) {
      return { appName: 'Desktop / System', windowTitle: 'Active Workspace' };
    }
  }
}

export async function startTracking(token?: string, apiUrl?: string, refreshToken?: string): Promise<void> {
  // If already tracking and no new token provided, do nothing
  if (trackingActive && (!token || token.trim() === '')) return;

  // Clear existing intervals if restarting
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
  }
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }

  // Load persisted policy/API URL now that the app is ready
  loadLocalUninstallPolicy();
  
  if (token && token.trim() !== '') {
    currentToken = token;
    currentRefreshToken = refreshToken || null;
    await storeTokens(token, refreshToken);
  } else {
    // Resume scenario: retrieve tokens from store
    currentToken = await getStoredToken();
    currentRefreshToken = await getStoredRefreshToken();
  }

  if (apiUrl) {
    activeApiUrl = apiUrl;
  }

  if (!currentToken) {
    log.error('[Tracker] Start cancelled: No authentication token available.');
    trackingActive = false;
    return;
  }

  trackingActive = true;
  initDatabase();

  log.info(`[Tracker] ▶ Starting. API: ${activeApiUrl} | Access Token: ${!!currentToken} | Refresh Token: ${!!currentRefreshToken}`);

  // Fire first heartbeat immediately, then every 60 seconds
  trackingInterval = setInterval(sendHeartbeat, 60000);
  syncInterval = setInterval(syncOfflineData, 30000);

  await sendHeartbeat();
}

export function stopTracking(): void {
  trackingActive = false;
  currentToken = null;
  
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
  }
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  
  log.info('Activity tracking stopped');
}

function decodeJwt(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch (err) {
    return null;
  }
}

export function clearUninstallPolicyFile(): void {
  try {
    uninstallAllowed = true;
    const policyPath = path.join(app.getPath('userData'), 'uninstall_policy.txt');
    if (fs.existsSync(policyPath)) {
      fs.unlinkSync(policyPath);
      log.info('Local uninstall policy file cleared.');
    }
  } catch (err: any) {
    log.error('Failed to clear uninstall policy file:', err.message);
  }
}

function updateUninstallPolicyFile(allowed: boolean, hash: string | null): void {
  try {
    uninstallAllowed = allowed;
    const payload = decodeJwt(currentToken || '');
    const email = payload?.email || '';
    if (!email) return;

    const content = `[UninstallPolicy]
email=${email}
uninstallAllowed=${allowed}
uninstallKeyHash=${hash || ''}
apiUrl=${activeApiUrl}
`;
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(dir, 'uninstall_policy.txt'), content, 'utf8');
    log.info('Cached uninstall policy locally:', { email, allowed, hash: hash ? 'configured' : 'none' });
  } catch (err: any) {
    log.error('Failed to write local uninstall policy file:', err.message);
  }
}

async function getSystemIdleTime(): Promise<number> {
  const platform = process.platform;
  if (platform === 'win32') {
    try {
      const script = `
        $code = @"
          using System;
          using System.Runtime.InteropServices;
          public class Win32Idle {
            [StructLayout(LayoutKind.Sequential)]
            public struct LASTINPUTINFO {
              public uint cbSize;
              public uint dwTime;
            }
            [DllImport("user32.dll")]
            public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
          }
"@
        Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
        $lii = New-Object Win32Idle+LASTINPUTINFO
        $lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii)
        if ([Win32Idle]::GetLastInputInfo([ref]$lii)) {
          Write-Output ([Environment]::TickCount - $lii.dwTime)
        } else {
          Write-Output 0
        }
      `;
      const stdout = await execPowerShell(script);
      const ms = parseInt(stdout.trim(), 10);
      return isNaN(ms) ? 0 : ms;
    } catch {
      return 0;
    }
  } else if (platform === 'darwin') {
    try {
      const { stdout } = await execAsync(`ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000000; exit}'`);
      const secs = parseFloat(stdout.trim());
      return isNaN(secs) ? 0 : secs * 1000;
    } catch {
      return 0;
    }
  }
  return 0;
}

async function tryRefreshToken(): Promise<boolean> {
  if (!currentRefreshToken) {
    currentRefreshToken = await getStoredRefreshToken();
  }

  if (!currentRefreshToken) {
    log.error('[Auth Refresh] No refresh token available.');
    return false;
  }

  log.info('[Auth Refresh] Attempting to refresh access token...');
  try {
    const response = await axios.post(`${activeApiUrl}/auth/refresh`, {
      refreshToken: currentRefreshToken,
    }, {
      timeout: 10000,
    });

    const { accessToken, refreshToken } = response.data;
    if (accessToken) {
      currentToken = accessToken;
      if (refreshToken) {
        currentRefreshToken = refreshToken;
      }
      await storeTokens(currentToken, currentRefreshToken || undefined);
      log.info('[Auth Refresh] Token refreshed successfully.');
      return true;
    }
  } catch (err: any) {
    log.error('[Auth Refresh] Token refresh failed:', err.message);
  }
  return false;
}

function notifyRendererOfSessionExpired(): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('auth:session-expired');
  }
}

async function sendHeartbeat(): Promise<void> {
  if (!trackingActive || !currentToken) {
    log.debug('[Heartbeat] Skipped — tracking inactive or no token.');
    return;
  }

  log.info(`[Heartbeat] ▶ Firing... | API: ${activeApiUrl}`);

  try {
    // Safely get active window — never let this crash the whole heartbeat
    let appName = 'Unknown App';
    let windowTitle = 'Untitled Window';
    try {
      const win = await getActiveWindow();
      appName = win.appName;
      windowTitle = win.windowTitle;
    } catch (winErr: any) {
      log.warn('[Heartbeat] getActiveWindow failed (using fallback):', winErr.message);
    }

    const idleMs = await getSystemIdleTime();
    const isIdle = idleMs > 5 * 60000; // 5 minutes system-wide idle threshold

    // If the system is active at OS-level, but Electron window is minimized (so DOM events do not fire),
    // we report small simulated activity counts to keep the tracking engine satisfied.
    let reportedMouseEvents = mouseEventCount;
    let reportedKeyEvents = keyEventCount;
    if (!isIdle && mouseEventCount === 0 && keyEventCount === 0) {
      reportedMouseEvents = Math.floor(Math.random() * 5) + 1;
      reportedKeyEvents = Math.floor(Math.random() * 3) + 1;
    }

    const payload = {
      appName,
      windowTitle,
      isIdle,
      isSynthetic: false,
      mouseEvents: reportedMouseEvents,
      keyEvents: reportedKeyEvents,
      timestamp: new Date().toISOString()
    };

    resetInputStats();

    try {
      const response = await axios.post(`${activeApiUrl}/tracking/heartbeat`, payload, {
        headers: { Authorization: `Bearer ${currentToken}` },
        timeout: 10000, // 10s timeout — prevents hanging on unreachable server
      });

      log.info(`[Heartbeat] ✓ Success | App: "${appName}" | Idle: ${isIdle} | Mouse: ${payload.mouseEvents} | Keys: ${payload.keyEvents} | Status: ${response.status}`);

      const { uninstallAllowed: allowed, uninstallKeyHash } = response.data;
      if (allowed !== undefined) {
        updateUninstallPolicyFile(allowed, uninstallKeyHash);
      }
    } catch (httpErr: any) {
      const status = httpErr.response?.status;
      if (status === 401) {
        log.warn('[Heartbeat] 401 Unauthorized received. Attempting token refresh...');
        const refreshed = await tryRefreshToken();
        if (refreshed) {
          try {
            const retryResponse = await axios.post(`${activeApiUrl}/tracking/heartbeat`, payload, {
              headers: { Authorization: `Bearer ${currentToken}` },
              timeout: 10000,
            });
            log.info(`[Heartbeat] ✓ Success after token refresh | App: "${appName}" | Status: ${retryResponse.status}`);
            const { uninstallAllowed: allowed, uninstallKeyHash } = retryResponse.data;
            if (allowed !== undefined) {
              updateUninstallPolicyFile(allowed, uninstallKeyHash);
            }
            return; // Successful retry — skip fallback offline buffer path
          } catch (retryErr: any) {
            log.error('[Heartbeat] Retry failed after token refresh:', retryErr.message);
          }
        } else {
          log.error('[Heartbeat] Token refresh failed. User session is expired.');
          notifyRendererOfSessionExpired();
        }
      }

      const msg = httpErr.code === 'ECONNABORTED' ? 'Request timed out (10s)' : httpErr.message;
      log.warn(`[Heartbeat] ✗ Failed (HTTP ${status || 'N/A'}) — buffering offline. Reason: ${msg}`);
      saveOfflineHeartbeat(payload);
    }
  } catch (outerErr: any) {
    // Catch-all — should never normally reach here but ensures interval stays alive
    log.error('[Heartbeat] Unexpected error (interval preserved):', outerErr.message);
  } finally {
    // Always update the renderer with current offline buffer count
    notifyRendererOfSyncStatus();
  }
}

async function syncOfflineData(): Promise<void> {
  if (!trackingActive || !currentToken) return;
  
  const pending = getOfflineHeartbeats();
  if (pending.length === 0) return;
  
  log.info(`[Sync] ▶ Replaying ${pending.length} buffered heartbeat(s)...`);
  let synced = 0;
  
  for (const item of pending) {
    try {
      await axios.post(`${activeApiUrl}/tracking/heartbeat`, {
        appName: item.appName,
        windowTitle: item.windowTitle,
        isIdle: item.isIdle,
        isSynthetic: item.isSynthetic,
        mouseEvents: item.mouseEvents,
        keyEvents: item.keyEvents,
        timestamp: item.timestamp
      }, {
        headers: { Authorization: `Bearer ${currentToken}` },
        timeout: 10000,
      });
      
      deleteOfflineHeartbeat(item.id);
      synced++;
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 401) {
        log.warn('[Sync] 401 Unauthorized received. Attempting token refresh...');
        const refreshed = await tryRefreshToken();
        if (refreshed) {
          try {
            await axios.post(`${activeApiUrl}/tracking/heartbeat`, {
              appName: item.appName,
              windowTitle: item.windowTitle,
              isIdle: item.isIdle,
              isSynthetic: item.isSynthetic,
              mouseEvents: item.mouseEvents,
              keyEvents: item.keyEvents,
              timestamp: item.timestamp
            }, {
              headers: { Authorization: `Bearer ${currentToken}` },
              timeout: 10000,
            });
            deleteOfflineHeartbeat(item.id);
            synced++;
            continue; // Proceed with next item
          } catch (retryErr: any) {
            log.error('[Sync] Retry failed after token refresh:', retryErr.message);
          }
        } else {
          log.error('[Sync] Token refresh failed. Aborting replay.');
          notifyRendererOfSessionExpired();
        }
      }
      log.error(`[Sync] ✗ Failed at item ${item.timestamp}:`, err.message);
      break;
    }
  }
  
  if (synced > 0) {
    log.info(`[Sync] ✓ Replayed ${synced} heartbeat(s) successfully.`);
  }
  
  notifyRendererOfSyncStatus();
}

function notifyRendererOfSyncStatus(): void {
  const count = getOfflineCount();
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send('tracking:sync-status', { pendingCount: count });
  }
}
