/**
 * ════════════════════════════════════════════════════════════════════════════
 *  I-AM-IOS Electron Main Process
 *  Fully contained desktop application with integrated local server
 * ════════════════════════════════════════════════════════════════════════════
 */

const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const isDev = require('electron-is-dev');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

// ── Configuration ──────────────────────────────────────────────────────────
const INTERNAL_PORT = 3000;
const APP_ROOT = isDev ? path.join(__dirname, '../') : path.join(process.resourcesPath, 'app');
const STATIC_ROOT = path.join(APP_ROOT, 'I-AM-IOS-V-Updated');

let mainWindow;
let httpServer;

// ── Presence Registry (WebSocket peer management) ──────────────────────────
class PresenceRegistry {
  constructor() {
    this.peers = new Map();
  }

  add(nodeId, data) {
    this.peers.set(nodeId, { ...data, seenAt: Date.now() });
  }

  remove(nodeId) {
    this.peers.delete(nodeId);
  }

  get(nodeId) {
    return this.peers.get(nodeId);
  }

  getAll() {
    return Array.from(this.peers.values());
  }

  cleanup() {
    const now = Date.now();
    const staleThreshold = 30000; // 30 seconds
    for (const [nodeId, peer] of this.peers) {
      if (now - peer.seenAt > staleThreshold) {
        this.peers.delete(nodeId);
      }
    }
  }
}

const presenceRegistry = new PresenceRegistry();

// ── WebSocket RFC-6455 Handshake ──────────────────────────────────────────
function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return false; }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return true;
}

function wsSend(socket, obj) {
  if (socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(obj));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { socket.write(Buffer.concat([header, payload])); } catch (_) {}
}

function wsParseFrames(buf, onMessage) {
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let payloadLen = buf[offset + 1] & 0x7f;
    let headerLen = 2;
    if (payloadLen === 126) {
      if (offset + 4 > buf.length) break;
      payloadLen = buf.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buf.length) break;
      payloadLen = Number(buf.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    if (offset + headerLen + payloadLen > buf.length) break;
    const maskStart = offset + headerLen;
    let payload;
    if (masked) {
      const mask = buf.slice(maskStart, maskStart + 4);
      payload = buf.slice(maskStart + 4, maskStart + 4 + payloadLen);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    } else {
      payload = buf.slice(maskStart, maskStart + payloadLen);
    }
    if (opcode === 1) { // text frame
      try { onMessage(JSON.parse(payload.toString('utf8'))); } catch (_) {}
    } else if (opcode === 8) { // close frame
      return 'CLOSE';
    }
    offset += headerLen + 4 * masked + payloadLen;
  }
  return null;
}

// ── Create HTTP Server with Presence + Static Files ────────────────────────
function createServer() {
  const server = http.createServer((req, res) => {
    // ── Presence API endpoints ─────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/api/peers') {
      presenceRegistry.cleanup();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(presenceRegistry.getAll()));
    }

    if (req.method === 'GET' && req.url === '/favicon.ico') {
      // Return a minimal favicon instead of 404
      const favicon = Buffer.from([
        0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10,
        0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x48, 0x01,
        0x00, 0x00, 0x16, 0x00, 0x00, 0x00, 0x28, 0x00,
        0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x20, 0x00,
        0x00, 0x00, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x80, 0x00,
        0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
      ]);
      res.writeHead(200, { 'Content-Type': 'image/x-icon' });
      return res.end(favicon);
    }

    // ── Static file serving ────────────────────────────────────────────────
    let filePath = path.join(STATIC_ROOT, req.url);
    if (req.url === '/') filePath = path.join(STATIC_ROOT, 'index.html');

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        return res.end('Not Found');
      }

      const ext = path.extname(filePath);
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.wasm': 'application/wasm',
      };

      const contentType = mimeTypes[ext] || 'application/octet-stream';
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(500);
          return res.end('Server Error');
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      });
    });
  });

  // ── WebSocket upgrade handler for presence ────────────────────────────────
  server.on('upgrade', (req, socket) => {
    if (req.url !== '/presence') return;

    if (!wsHandshake(req, socket)) return;

    let nodeId = null;
    let peerId = null;
    let bufferedData = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      bufferedData = Buffer.concat([bufferedData, chunk]);
      const closeCode = wsParseFrames(bufferedData, (msg) => {
        if (!nodeId && msg.type === 'announce') {
          nodeId = msg.nodeId || crypto.randomUUID();
          peerId = msg.peerId || `peer-${nodeId.slice(0, 8)}`;
          presenceRegistry.add(nodeId, {
            nodeId,
            peerId,
            handle: msg.handle || 'Anonymous',
            name: msg.name || 'Peer',
            tier: msg.tier || 'STANDARD',
            capabilities: msg.capabilities || [],
          });
          wsSend(socket, { type: 'announced', nodeId });
        } else if (msg.type === 'list') {
          presenceRegistry.cleanup();
          wsSend(socket, { type: 'peers', peers: presenceRegistry.getAll() });
        }
      });
      if (closeCode === 'CLOSE') socket.destroy();
      bufferedData = Buffer.alloc(0);
    });

    socket.on('end', () => {
      if (nodeId) presenceRegistry.remove(nodeId);
    });

    socket.on('error', () => {
      if (nodeId) presenceRegistry.remove(nodeId);
    });
  });

  return server;
}

// ── Create Electron Window ─────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      sandbox: true,
    },
    icon: path.join(__dirname, 'assets/icon.png'),
  });

  mainWindow.loadURL(`http://localhost:${INTERNAL_PORT}`);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle any uncaught exceptions in renderer
  mainWindow.webContents.on('crashed', () => {
    console.error('Renderer process crashed');
    mainWindow.reload();
  });
}

// ── App Lifecycle ──────────────────────────────────────────────────────────
app.on('ready', () => {
  // Start internal server
  httpServer = createServer();
  httpServer.listen(INTERNAL_PORT, '127.0.0.1', () => {
    console.log(`[I-AM-IOS] Local server running on http://localhost:${INTERNAL_PORT}`);
    // Create window after server is ready
    createWindow();
    createMenu();
  });
});

app.on('window-all-closed', () => {
  // Cleanup
  if (httpServer) {
    httpServer.close(() => {
      console.log('[I-AM-IOS] Server closed');
      if (process.platform !== 'darwin') app.quit();
    });
  } else if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

// ── Application Menu ───────────────────────────────────────────────────────
function createMenu() {
  const template = [
    {
      label: 'I-AM-IOS',
      submenu: [
        { label: 'About I-AM-IOS', role: 'about' },
        { type: 'separator' },
        { label: 'Preferences...', accelerator: 'CmdOrCtrl+,', click: () => {
          if (mainWindow) mainWindow.webContents.send('open-preferences');
        }},
        { type: 'separator' },
        { label: 'Quit I-AM-IOS', accelerator: 'CmdOrCtrl+Q', role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', role: 'forceReload' },
        { label: 'Toggle DevTools', accelerator: 'CmdOrCtrl+Shift+I', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', role: 'zoomIn' },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Toggle Full Screen', accelerator: 'F11', role: 'togglefullscreen' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ── IPC Handlers for Renderer Communication ────────────────────────────────
ipcMain.handle('get-app-info', () => {
  return {
    appName: 'I-AM-IOS',
    version: app.getVersion(),
    isDev,
    serverPort: INTERNAL_PORT,
    serverURL: `http://localhost:${INTERNAL_PORT}`,
  };
});

ipcMain.handle('get-peers', () => {
  presenceRegistry.cleanup();
  return presenceRegistry.getAll();
});

ipcMain.handle('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  }
});

ipcMain.handle('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.on('log', (event, message) => {
  console.log('[RENDERER]', message);
});

// ── Error Handling ─────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

module.exports = { app, mainWindow };
