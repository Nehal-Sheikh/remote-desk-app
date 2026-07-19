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

const execAsync = promisify(exec);

let trackingInterval: NodeJS.Timeout | null = null;
let syncInterval: NodeJS.Timeout | null = null;
let currentToken: string | null = null;
let trackingActive = false;

let mouseEventCount = 0;
let keyEventCount = 0;
let lastInputTime = Date.now();

export function resetInputStats(): void {
  mouseEventCount = 0;
  keyEventCount = 0;
}

export function isTracking(): boolean {
  return trackingActive;
}

// Shell-based active window tracking to avoid node-gyp native compilation dependency issues
async function getActiveWindow(): Promise<{ appName: string; windowTitle: string }> {
  const platform = process.platform;
  
  if (platform === 'win32') {
    try {
      const cmd = `powershell -NoProfile -Command "
        $code = @'
          using System;
          using System.Runtime.InteropServices;
          using System.Text;
          public class Win32 {
            [DllImport(\\"user32.dll\\")]
            public static extern IntPtr GetForegroundWindow();
            [DllImport(\\"user32.dll\\")]
            public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
            [DllImport(\\"user32.dll\\")]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
          }
'@
        Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue
        $hwnd = [Win32]::GetForegroundWindow()
        $title = New-Object System.Text.StringBuilder 256
        $null = [Win32]::GetWindowText($hwnd, $title, 256)
        $processId = 0
        $null = [Win32]::GetWindowThreadProcessId($hwnd, [ref]$processId)
        $process = Get-Process -Id $processId
        [PSCustomObject]@{
          AppName = $process.ProcessName
          Title = $title.ToString()
        } | ConvertTo-Json
      "`;
      
      const { stdout } = await execAsync(cmd);
      const parsed = JSON.parse(stdout.trim());
      return {
        appName: parsed.AppName || 'Unknown App',
        windowTitle: parsed.Title || 'Untitled Window'
      };
    } catch (err) {
      return { appName: 'Unknown App', windowTitle: 'Untitled Window' };
    }
  } else if (platform === 'darwin') {
    try {
      const cmd = `osascript -e 'tell application "System Events" to set frontApp to name of first application process whose frontmost is true' -e 'tell application "System Events" to tell process frontApp to set windowTitle to name of first window' -e 'return frontApp & "::" & windowTitle'`;
      const { stdout } = await execAsync(cmd);
      const parts = stdout.trim().split('::');
      return {
        appName: parts[0] || 'Unknown App',
        windowTitle: parts[1] || 'Untitled Window'
      };
    } catch (err) {
      return { appName: 'Unknown App', windowTitle: 'Untitled Window' };
    }
  } else {
    // Linux / X11 fallback
    try {
      const { stdout: title } = await execAsync('xdotool getactivewindow getwindowname');
      const { stdout: appName } = await execAsync('xdotool getactivewindow getwindowpid | xargs ps -o comm= -p');
      return {
        appName: appName.trim() || 'Unknown App',
        windowTitle: title.trim() || 'Untitled Window'
      };
    } catch (err) {
      return { appName: 'Unknown App', windowTitle: 'Untitled Window' };
    }
  }
}

export async function startTracking(token: string): Promise<void> {
  if (trackingActive) return;
  
  if (token) {
    currentToken = token;
  }
  trackingActive = true;
  initDatabase();
  
  trackingInterval = setInterval(sendHeartbeat, 60000);
  syncInterval = setInterval(syncOfflineData, 30000);
  
  log.info('Activity tracking started');
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
    const payload = decodeJwt(currentToken || '');
    const email = payload?.email || '';
    if (!email) return;

    const apiUrl = process.env.VITE_API_URL || 'http://localhost:3000';
    const content = `[UninstallPolicy]
email=${email}
uninstallAllowed=${allowed}
uninstallKeyHash=${hash || ''}
apiUrl=${apiUrl}
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

async function sendHeartbeat(): Promise<void> {
  if (!trackingActive || !currentToken) return;

  const { appName, windowTitle } = await getActiveWindow();
  const isIdle = Date.now() - lastInputTime > 5 * 60000;
  const isSynthetic = false;
  
  const payload = {
    appName,
    windowTitle,
    isIdle,
    isSynthetic,
    mouseEvents: mouseEventCount,
    keyEvents: keyEventCount,
    timestamp: new Date().toISOString()
  };

  resetInputStats();

  try {
    const apiUrl = process.env.VITE_API_URL || 'http://localhost:3000';
    const response = await axios.post(`${apiUrl}/tracking/heartbeat`, payload, {
      headers: {
        Authorization: `Bearer ${currentToken}`
      }
    });
    log.info('Heartbeat sent successfully to backend:', appName);

    // Sync uninstall policy with the response payload
    const { uninstallAllowed, uninstallKeyHash } = response.data;
    if (uninstallAllowed !== undefined) {
      updateUninstallPolicyFile(uninstallAllowed, uninstallKeyHash);
    }
  } catch (err: any) {
    log.warn('Backend unreachable. Saving to offline SQLite buffer:', err.message);
    saveOfflineHeartbeat(payload);
    notifyRendererOfSyncStatus();
  }
}

async function syncOfflineData(): Promise<void> {
  if (!trackingActive || !currentToken) return;
  
  const pending = getOfflineHeartbeats();
  if (pending.length === 0) return;
  
  log.info(`Sync: Attempting to replay ${pending.length} offline heartbeats...`);
  
  for (const item of pending) {
    try {
      const apiUrl = process.env.VITE_API_URL || 'http://localhost:3000';
      await axios.post(`${apiUrl}/tracking/heartbeat`, {
        appName: item.appName,
        windowTitle: item.windowTitle,
        isIdle: item.isIdle,
        isSynthetic: item.isSynthetic,
        mouseEvents: item.mouseEvents,
        keyEvents: item.keyEvents,
        timestamp: item.timestamp
      }, {
        headers: {
          Authorization: `Bearer ${currentToken}`
        }
      });
      
      deleteOfflineHeartbeat(item.id);
    } catch (err: any) {
      log.error('Sync failed at item:', item.timestamp, err.message);
      break;
    }
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
