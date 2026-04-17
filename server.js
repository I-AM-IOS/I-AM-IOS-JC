#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  server.js  —  Sovereign Compute Network local dev server
//  Usage:  node server.js [port]
//
//  Presence registry (zero dependencies — pure Node built-ins):
//    WS  ws://localhost:PORT/presence    — live peer announce/leave/list
//    GET /api/peers                      — snapshot of online peers (JSON)
// ════════════════════════════════════════════════════════════════════════════
import http   from 'node:http';
import fs     from 'node:fs';
import path   from 'node:path';
import url    from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// ════════════════════════════════════════════════════════════════════════════
//  Presence Registry — pure Node, zero deps
//  Uses the raw HTTP Upgrade handshake to speak WebSocket (RFC 6455).
//  Peers announce on connect, auto-expire on disconnect.
// ════════════════════════════════════════════════════════════════════════════

// Map of nodeId → { nodeId, handle, name, ws, seenAt }
const peers = new Map();

// ── Minimal RFC-6455 WebSocket frame parser / encoder ───────────────────────
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
  const len     = payload.length;
  let   header;
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

// Parse one or more frames from a raw chunk; calls onMessage(parsedObj) for each
function wsParseFrames(buf, onMessage) {
  let offset = 0;
  while (offset + 2 <= buf.length) {
    // const fin  = (buf[offset] & 0x80) !== 0;  // FIN bit (unused here)
    const opcode = buf[offset] & 0x0f;
    const masked  = (buf[offset + 1] & 0x80) !== 0;
    let   payloadLen = buf[offset + 1] & 0x7f;
    let   headerLen  = 2;
    if (payloadLen === 126) {
      if (offset + 4 > buf.length) break;
      payloadLen = buf.readUInt16BE(offset + 2);
      headerLen  = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buf.length) break;
      payloadLen = Number(buf.readBigUInt64BE(offset + 2));
      headerLen  = 10;
    }
    const maskOffset = offset + headerLen;
    const dataOffset = maskOffset + (masked ? 4 : 0);
    if (dataOffset + payloadLen > buf.length) break;
    if (opcode === 8) { onMessage({ op: '__close__' }); break; }  // close frame
    if (opcode === 9) { /* ping — pong handled below */ }
    if (opcode === 1 || opcode === 2) {
      let data = buf.slice(dataOffset, dataOffset + payloadLen);
      if (masked) {
        const mask = buf.slice(maskOffset, maskOffset + 4);
        data = Buffer.from(data.map((b, i) => b ^ mask[i % 4]));
      }
      try { onMessage(JSON.parse(data.toString())); } catch (_) {}
    }
    offset = dataOffset + payloadLen;
  }
}

// Broadcast a message to every connected peer except the sender
function broadcast(msg, exceptNodeId) {
  for (const [id, p] of peers) {
    if (id !== exceptNodeId) wsSend(p.socket, msg);
  }
}

// Snapshot of currently online peers (without socket handles)
function peerList() {
  return [...peers.values()].map(({ nodeId, handle, name, seenAt }) =>
    ({ nodeId, handle, name, seenAt })
  );
}

// ── WebSocket connection handler ─────────────────────────────────────────────
function handlePresenceSocket(req, socket) {
  if (!wsHandshake(req, socket)) return;

  let nodeId = null;

  socket.on('data', buf => {
    wsParseFrames(buf, msg => {
      if (msg.op === '__close__') { socket.destroy(); return; }

      // ANNOUNCE — peer introduces itself
      if (msg.op === 'ANNOUNCE' && msg.nodeId) {
        nodeId = msg.nodeId;
        peers.set(nodeId, {
          nodeId,
          handle:  msg.handle  || '',
          name:    msg.name    || '',
          socket,
          seenAt:  Date.now(),
        });
        // Send back the current peer list
        wsSend(socket, { op: 'PEERS', peers: peerList() });
        // Tell everyone else about the newcomer
        broadcast({ op: 'PEER_JOINED', nodeId, handle: msg.handle, name: msg.name }, nodeId);
        console.log(`  [presence] + ${nodeId.slice(0, 16)}… (${msg.handle})`);
      }

      // PING — keep-alive, reply with PONG
      if (msg.op === 'PING') {
        if (nodeId && peers.has(nodeId)) peers.get(nodeId).seenAt = Date.now();
        wsSend(socket, { op: 'PONG' });
      }
    });
  });

  socket.on('close', () => removePeer(nodeId));
  socket.on('error', () => removePeer(nodeId));
}

function removePeer(nodeId) {
  if (!nodeId || !peers.has(nodeId)) return;
  peers.delete(nodeId);
  broadcast({ op: 'PEER_LEFT', nodeId }, nodeId);
  console.log(`  [presence] - ${nodeId.slice(0, 16)}…`);
}

// Evict peers that haven't pinged in 40 s (stale tabs, mobile sleep, etc.)
setInterval(() => {
  const cutoff = Date.now() - 40_000;
  for (const [id, p] of peers) {
    if (p.seenAt < cutoff) { p.socket.destroy(); removePeer(id); }
  }
}, 15_000);
const PORT = parseInt(process.argv[2] ?? process.env.PORT ?? '3000', 10);
const ROOT = __dirname;

// ── L4.5: read validator config from environment ──────────────────────────────
const VALIDATOR_ENDPOINT = process.env.VALIDATOR_ENDPOINT || '';
const FALLBACK_TIMEOUT   = parseInt(process.env.FALLBACK_TIMEOUT ?? '2000', 10);
const CHECK_INTERVAL     = 5000;

// Injected before </head> in every HTML response so sovereign-log-inline.js
// can read window.SOVEREIGN_CONFIG without needing ES-module imports.
const CONFIG_SCRIPT = VALIDATOR_ENDPOINT
  ? `<script>window.SOVEREIGN_CONFIG=${JSON.stringify({
      validatorEndpoint: VALIDATOR_ENDPOINT,
      fallbackTimeout:   FALLBACK_TIMEOUT,
      checkInterval:     CHECK_INTERVAL,
    })};</script>`
  : '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.ts':   'text/plain; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.wasm': 'application/wasm',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.pdf':  'application/pdf',
};

const server = http.createServer((req, res) => {
  const parsed  = new URL(req.url, 'http://localhost');
  let   relPath = decodeURIComponent(parsed.pathname);

  // ── REST snapshot endpoint ────────────────────────────────────────────────
  if (relPath === '/api/peers') {
    const body = JSON.stringify(peerList());
    res.writeHead(200, {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'no-cache',
    });
    res.end(body);
    return;
  }

  // ── Favicon handler (prevent 404) ───────────────────────────────────────
  if (relPath === '/favicon.ico') {
    const svg = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%23070b0f' width='100' height='100'/><circle fill='%2322d3ee' cx='50' cy='50' r='35'/></svg>`;
    res.writeHead(301, { 'Location': svg });
    res.end();
    return;
  }

  if (relPath === '/') relPath = '/index.html';

  const absPath = path.join(ROOT, relPath);
  if (!absPath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }

  // ── Directory router — /apps/foo/ or /apps/foo → /apps/foo/index.html ────
  // If the path has no extension and resolves to a directory that contains
  // an index.html, redirect to it. This must run before the fs.stat file check.
  if (!path.extname(relPath)) {
    let dirStat;
    try { dirStat = fs.statSync(absPath); } catch (_) {}
    if (dirStat?.isDirectory()) {
      const target    = relPath.replace(/\/$/, '') + '/index.html';
      const indexPath = path.join(ROOT, target);
      if (fs.existsSync(indexPath)) {
        res.writeHead(301, { Location: target });
        res.end();
        return;
      }
    }
  }

  fs.stat(absPath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found: ${relPath}`);
      return;
    }
    const ext  = path.extname(absPath).toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    fs.readFile(absPath, (e2, data) => {
      if (e2) { res.writeHead(500); res.end('Error'); return; }
      let body = data;
      // Inject window.SOVEREIGN_CONFIG into HTML files so inline scripts
      // can reach the validator without needing ES-module imports.
      if (ext === '.html' && CONFIG_SCRIPT) {
        body = Buffer.from(data.toString().replace('</head>', CONFIG_SCRIPT + '</head>'));
      }
      res.writeHead(200, {
        'Content-Type':  mime,
        'Cache-Control': 'no-cache',
        'Cross-Origin-Opener-Policy':   'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      res.end(body);
    });
  });
});

// ── WebSocket upgrade — /presence path only ───────────────────────────────
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/presence') {
    handlePresenceSocket(req, socket);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  ╔══════════════════════════════════════════════════╗');
  console.log('  ║   SOVEREIGN COMPUTE NETWORK — dev server ready   ║');
  console.log('  ╚══════════════════════════════════════════════════╝\n');
  console.log(`  Portal       →  http://localhost:${PORT}/`);
  console.log(`  App Builder  →  http://localhost:${PORT}/apps/app-builder-v2.html`);
  console.log(`  Attack       →  http://localhost:${PORT}/apps/attack.html`);
  console.log(`  Fabric       →  http://localhost:${PORT}/apps/generate-value.html`);
  console.log(`  Genesis      →  http://localhost:${PORT}/apps/index1.html`);
  console.log(`  Social       →  http://localhost:${PORT}/apps/I-AM-Social/I-AM-Social.html`);
  console.log(`\n  Presence WS  →  ws://localhost:${PORT}/presence`);
  console.log(`  Peers REST   →  http://localhost:${PORT}/api/peers`);
  console.log(`\n  Ledger persists to:  IndexedDB (sovereign-ledger)`);
  console.log(`  Bus channel:         BroadcastChannel(sovereign-os-bus)`);
  console.log(`  Ollama endpoint:     http://localhost:11434  (optional)`);
  if (VALIDATOR_ENDPOINT) {
    console.log(`\n  ✓ Validator (L4.5):  ${VALIDATOR_ENDPOINT}`);
  } else {
    console.log(`\n  ⚠  Validator:        not configured (pure P2P mode)`);
    console.log(`     Set VALIDATOR_ENDPOINT in .env to enable hybrid network`);
  }
  console.log('');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} in use. Try: node server.js ${PORT + 1}\n`);
  else console.error(err);
  process.exit(1);
});