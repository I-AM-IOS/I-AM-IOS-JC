#!/usr/bin/env node
/**
 * planespace CLI
 * Commands: init, audit, dev
 */

import { audit } from '../lib/audit.js';
import { init }  from '../lib/init.js';
import { dev }   from '../lib/dev.js';

const VERSION = '1.0.0';

const c = {
  bold: '\x1b[1m', reset: '\x1b[0m', dim: '\x1b[2m',
  cyan: '\x1b[36m', gray: '\x1b[90m', green: '\x1b[32m', yellow: '\x1b[33m',
};
const bold  = s => `${c.bold}${s}${c.reset}`;
const cyan  = s => `${c.cyan}${s}${c.reset}`;
const gray  = s => `${c.gray}${s}${c.reset}`;
const dim   = s => `${c.dim}${s}${c.reset}`;

function printHelp() {
  console.log(`
  ${bold('planespace')} v${VERSION}

  ${bold('Usage:')}
    planespace <command> [options]

  ${bold('Commands:')}

    ${cyan('init')} <name>            Scaffold a new planespace project
      ${dim('--mode')} ${gray('<mode>')}        Warp mode: transform (default) | reproject
      ${dim('--force')}               Overwrite existing directory

    ${cyan('audit')} <file.html>      Analyze HTML for depth issues
      ${dim('--depth-attr')} ${gray('<attr>')}  Attribute name (default: data-z)

    ${cyan('dev')}                    Start local dev server with live reload
      ${dim('--port')} ${gray('<n>')}            Port (default: 3000)
      ${dim('--root')} ${gray('<dir>')}          Serve from directory (default: .)

  ${bold('Examples:')}
    planespace init my-scene
    planespace init my-scene --mode reproject
    planespace audit index.html
    planespace dev --port 8080
    planespace dev --root ./public

  ${bold('Notes on reproject mode:')}
    The actual planespace source checks for window.html2canvas — there is no
    captureStream implementation despite what the docs say. For reproject mode
    to work, load html2canvas before planespace.min.js.

`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0];
  const positional = [];
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }

  return { cmd, positional, flags };
}

// ── Entry ────────────────────────────────────────────────────────────────────

const { cmd, positional, flags } = parseArgs(process.argv);

if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  printHelp();
  process.exit(0);
}

if (cmd === '--version' || cmd === '-v') {
  console.log(VERSION);
  process.exit(0);
}

switch (cmd) {

  case 'init': {
    const name = positional[0];
    if (!name) {
      console.error('\n  Usage: planespace init <project-name>\n');
      process.exit(1);
    }
    init(name, {
      mode:  flags.mode  || 'transform',
      force: !!flags.force,
    });
    break;
  }

  case 'audit': {
    const file = positional[0];
    if (!file) {
      console.error('\n  Usage: planespace audit <file.html>\n');
      process.exit(1);
    }
    audit(file, {
      depthAttr: flags.depthAttr || flags['depth-attr'],
    });
    break;
  }

  case 'dev': {
    dev({
      port: flags.port ? parseInt(flags.port, 10) : 3000,
      root: flags.root || '.',
    });
    break;
  }

  default: {
    console.error(`\n  Unknown command: "${cmd}". Run planespace --help\n`);
    process.exit(1);
  }
}
