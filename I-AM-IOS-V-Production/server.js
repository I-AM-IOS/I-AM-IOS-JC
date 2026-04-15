#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════════════
//  server.js  —  Sovereign Compute Network local dev server
//  Usage:  node server.js [port]
// ════════════════════════════════════════════════════════════════════════════
import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import url  from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
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
};

const server = http.createServer((req, res) => {
  const parsed  = new URL(req.url, 'http://localhost');
  let   relPath = decodeURIComponent(parsed.pathname);
  if (relPath === '/') relPath = '/index.html';

  const absPath = path.join(ROOT, relPath);
  if (!absPath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }

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

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n  ╔══════════════════════════════════════════════════╗');
  console.log('  ║   SOVEREIGN COMPUTE NETWORK — dev server ready   ║');
  console.log('  ╚══════════════════════════════════════════════════╝\n');
  console.log(`  Portal       →  http://localhost:${PORT}/`);
  console.log(`  App Builder  →  http://localhost:${PORT}/apps/app-builder-v2.html`);
  console.log(`  Attack       →  http://localhost:${PORT}/apps/attack.html`);
  console.log(`  Fabric       →  http://localhost:${PORT}/apps/generate-value.html`);
  console.log(`  Genesis      →  http://localhost:${PORT}/apps/index1.html`);
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
