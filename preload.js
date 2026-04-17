/**
 * ════════════════════════════════════════════════════════════════════════════
 *  I-AM-IOS Electron Preload Script
 *  Secure bridge between main and renderer processes
 * ════════════════════════════════════════════════════════════════════════════
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose only necessary APIs to the renderer process
contextBridge.exposeInMainWorld('iamElectron', {
  // App Info
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  
  // Peer Management
  getPeers: () => ipcRenderer.invoke('get-peers'),
  onPeersUpdated: (callback) => ipcRenderer.on('peers-updated', (_, peers) => callback(peers)),
  
  // Window Controls
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),
  
  // Logging
  log: (message) => ipcRenderer.send('log', message),
  
  // Preferences
  onOpenPreferences: (callback) => ipcRenderer.on('open-preferences', callback),
  
  // Platform Detection
  platform: process.platform,
  nodeVersion: process.versions.node,
  chromeVersion: process.versions.chrome,
  electronVersion: process.versions.electron,
});

// Override console methods to send to main process
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
  originalLog(...args);
  ipcRenderer.send('log', args.join(' '));
};

console.error = (...args) => {
  originalError(...args);
  ipcRenderer.send('log', `[ERROR] ${args.join(' ')}`);
};

console.warn = (...args) => {
  originalWarn(...args);
  ipcRenderer.send('log', `[WARN] ${args.join(' ')}`);
};
