/**
 * planespace dev
 * Minimal static file server with live-reload for planespace projects.
 */

import { createServer } from 'http';
import { readFileSync, statSync, existsSync, watch } from 'fs';
import { extname, resolve, join } from 'path';
import { createHash } from 'crypto';

const c = {
  bold: '\x1b[1m', reset: '\x1b[0m', dim: '\x1b[2m',
  green: '\x1b[32m', cyan: '\x1b[36m', gray: '\x1b[90m',
  red: '\x1b[31m', yellow: '\x1b[33m',
};
const bold   = s => `${c.bold}${s}${c.reset}`;
const green  = s => `${c.green}${s}${c.reset}`;
const cyan   = s => `${c.cyan}${s}${c.reset}`;
const gray   = s => `${c.gray}${s}${c.reset}`;
const red    = s => `${c.red}${s}${c.reset}`;
const yellow = s => `${c.yellow}${s}${c.reset}`;
const dim    = s => `${c.dim}${s}${c.reset}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.map':  'application/json',
  '.ts':   'application/javascript; charset=utf-8', // serve .d.ts
};

// SSE clients waiting for reload signal
const sseClients = new Set();

// Injected into HTML responses for live reload
const LIVE_RELOAD_SCRIPT = `
<script>
(function() {
  const es = new EventSource('/__planespace_reload');
  es.onmessage = () => { console.log('[planespace dev] reloading...'); location.reload(); };
  es.onerror   = () => { es.close(); };
})();
</script>
`;

function serveFile(req, res, root) {
  let urlPath = req.url.split('?')[0];

  // SSE endpoint
  if (urlPath === '/__planespace_reload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('data: connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  const filePath = join(root, urlPath);

  // Security: stay within root
  if (!filePath.startsWith(resolve(root))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  if (!existsSync(filePath)) {
    // Try index.html for SPA-style routing
    const indexPath = join(root, 'index.html');
    if (existsSync(indexPath) && !extname(urlPath)) {
      return serveStaticFile(indexPath, req, res, true);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not found: ${urlPath}`);
    return;
  }

  let stat;
  try { stat = statSync(filePath); } catch {
    res.writeHead(500); res.end('stat error'); return;
  }

  if (stat.isDirectory()) {
    const idx = join(filePath, 'index.html');
    if (existsSync(idx)) return serveStaticFile(idx, req, res, true);
    res.writeHead(404); res.end('No index.html in directory'); return;
  }

  serveStaticFile(filePath, req, res, false);
}

function serveStaticFile(filePath, req, res, isHtmlByDefault) {
  const ext = extname(filePath).toLowerCase();
  const isHtml = isHtmlByDefault || ext === '.html' || ext === '.htm';
  const mime = MIME[ext] || 'application/octet-stream';

  let body;
  try {
    body = readFileSync(filePath);
  } catch (e) {
    res.writeHead(500); res.end('Read error'); return;
  }

  if (isHtml) {
    let html = body.toString('utf8');
    // Inject live reload before </body>
    if (html.includes('</body>')) {
      html = html.replace('</body>', LIVE_RELOAD_SCRIPT + '</body>');
    } else {
      html += LIVE_RELOAD_SCRIPT;
    }
    body = Buffer.from(html, 'utf8');
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function notifyReload() {
  for (const client of sseClients) {
    try { client.write('data: reload\n\n'); } catch {}
  }
}

function startWatcher(root) {
  const debounceMap = new Map();
  try {
    watch(root, { recursive: true }, (event, filename) => {
      if (!filename) return;
      if (filename.includes('node_modules')) return;
      // Debounce per file
      if (debounceMap.has(filename)) clearTimeout(debounceMap.get(filename));
      debounceMap.set(filename, setTimeout(() => {
        debounceMap.delete(filename);
        console.log(`  ${gray('changed')}  ${filename}`);
        notifyReload();
      }, 80));
    });
  } catch (e) {
    console.warn(`  ${yellow('⚠')}  File watcher unavailable: ${e.message}`);
  }
}

export function dev(opts = {}) {
  const port = opts.port || 3000;
  const root = resolve(opts.root || '.');

  const server = createServer((req, res) => {
    serveFile(req, res, root);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  ${red('✖')}  Port ${port} is already in use. Try: planespace dev --port ${port + 1}\n`);
    } else {
      console.error(`\n  ${red('✖')}  Server error: ${e.message}\n`);
    }
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`\n  ${bold('planespace dev')}\n`);
    console.log(`  ${green('✔')}  ${bold(`http://localhost:${port}`)}`);
    console.log(`  ${gray('root:')}  ${root}`);
    console.log(`  ${gray('live reload:  enabled')}`);
    console.log(`\n  ${dim('Press Ctrl+C to stop')}\n`);
    startWatcher(root);
  });

  process.on('SIGINT', () => {
    console.log(`\n  ${gray('Server stopped.')}\n`);
    server.close();
    process.exit(0);
  });
}
