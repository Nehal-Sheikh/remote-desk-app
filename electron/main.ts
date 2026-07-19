import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import log from 'electron-log'
import { startTracking, stopTracking, isTracking, clearUninstallPolicyFile } from './tracker'
import { getStoredToken, clearToken } from './token-store'

// Configure logging
log.transports.file.level = 'info'
autoUpdater.logger = log

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

// ── Single instance lock ─────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}
app.on('second-instance', () => {
  mainWindow?.show()
  mainWindow?.focus()
})

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#0d1117',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    e.preventDefault()
    mainWindow?.hide()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── Tray ─────────────────────────────────────────────────────────────────────
function buildTrayMenu(tracking: boolean): Menu {
  return Menu.buildFromTemplate([
    { label: 'Remote Desk Agent', enabled: false },
    { type: 'separator' },
    {
      label: tracking ? '🟢  Tracking Active' : '🔴  Not Tracking',
      enabled: false
    },
    { type: 'separator' },
    { label: 'Open', click: () => mainWindow?.show() },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        stopTracking()
        app.exit(0)
      }
    }
  ])
}

function createTray(): void {
  const iconPath = join(__dirname, '../../build/tray-icon.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('Remote Desk Agent')
  tray.setContextMenu(buildTrayMenu(false))

  tray.on('click', () => {
    mainWindow?.isVisible() ? mainWindow?.hide() : mainWindow?.show()
  })
}

function refreshTray(): void {
  tray?.setContextMenu(buildTrayMenu(isTracking()))
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────
function registerIpcHandlers(): void {
  ipcMain.handle('auth:start-tracking', async (_, token: string) => {
    try {
      await startTracking(token)
      refreshTray()
      return { success: true }
    } catch (err) {
      log.error('start-tracking error', err)
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('auth:stop-tracking', async () => {
    stopTracking()
    refreshTray()
    return { success: true }
  })

  ipcMain.handle('auth:get-status', () => {
    return { isTracking: isTracking() }
  })

  ipcMain.handle('auth:logout', async () => {
    stopTracking()
    clearUninstallPolicyFile()
    await clearToken()
    refreshTray()
    return { success: true }
  })

  ipcMain.handle('window:hide', () => mainWindow?.hide())
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  electronApp.setAppUserModelId('io.remotedesk.agent')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  createTray()
  registerIpcHandlers()

  // Auto-resume tracking if a token is stored
  const storedToken = await getStoredToken()
  if (storedToken) {
    try {
      await startTracking(storedToken)
      refreshTray()
      mainWindow?.hide() // Start minimized if already authenticated
    } catch {
      // Token may be expired — let user re-login
    }
  }

  // Auto-updater (production only)
  if (!is.dev) {
    autoUpdater.checkForUpdatesAndNotify()
    setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000)

    autoUpdater.on('update-available', () => {
      mainWindow?.webContents.send('updater:available')
    })
    autoUpdater.on('update-downloaded', () => {
      mainWindow?.webContents.send('updater:ready')
    })
  }
})

app.on('activate', () => {
  mainWindow?.show()
})

// Prevent full quit on macOS — stay in tray
app.on('window-all-closed', () => {
  // Do nothing, preventing the app from quitting automatically
})
