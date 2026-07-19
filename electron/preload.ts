import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  startTracking: (token: string) => ipcRenderer.invoke('auth:start-tracking', token),
  stopTracking: () => ipcRenderer.invoke('auth:stop-tracking'),
  getStatus: () => ipcRenderer.invoke('auth:get-status'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  onSyncStatus: (callback: (data: { pendingCount: number }) => void) => {
    const listener = (_event: any, data: { pendingCount: number }) => callback(data);
    ipcRenderer.on('tracking:sync-status', listener);
    return () => ipcRenderer.removeListener('tracking:sync-status', listener);
  },
  onUpdaterAvailable: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('updater:available', listener);
    return () => ipcRenderer.removeListener('updater:available', listener);
  },
  onUpdaterReady: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('updater:ready', listener);
    return () => ipcRenderer.removeListener('updater:ready', listener);
  }
});
