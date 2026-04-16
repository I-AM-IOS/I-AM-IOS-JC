/**
 * planespace init
 * Scaffolds a new planespace project.
 */

import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { resolve, join } from 'path';

const c = {
  bold:  '\x1b[1m', reset: '\x1b[0m', dim: '\x1b[2m',
  green: '\x1b[32m', cyan: '\x1b[36m', gray: '\x1b[90m', yellow: '\x1b[33m',
};
const bold  = s => `${c.bold}${s}${c.reset}`;
const green = s => `${c.green}${s}${c.reset}`;
const cyan  = s => `${c.cyan}${s}${c.reset}`;
const gray  = s => `${c.gray}${s}${c.reset}`;
const dim   = s => `${c.dim}${s}${c.reset}`;

// ── Templates ────────────────────────────────────────────────────────────────

function makeIndexHtml(name, warpMode) {
  const needsH2C = warpMode === 'reproject';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0e0f13;
      color: #e8e9ed;
      height: 100vh;
      overflow: hidden;
    }

    .scene {
      position: relative;
      width: 100vw;
      height: 100vh;
    }

    .layer {
      position: absolute;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 28px 32px;
      backdrop-filter: blur(12px);
    }

    .layer-bg {
      left: 10%;
      top: 15%;
      width: 300px;
    }

    .layer-mid {
      left: 30%;
      top: 30%;
      width: 360px;
      background: rgba(255,255,255,0.06);
      border-color: rgba(255,255,255,0.14);
    }

    .layer-fg {
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: 420px;
      background: rgba(255,255,255,0.08);
      border-color: rgba(255,255,255,0.2);
    }

    h2 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    p  { font-size: 14px; color: rgba(255,255,255,0.6); line-height: 1.6; }
  </style>
</head>
<body>
${needsH2C ? `  <!-- Required for reproject mode: html2canvas must be present before planespace -->
  <script src="https://html2canvas.hertzen.com/dist/html2canvas.min.js"></script>
` : ''}
<div class="scene" data-z="0">

  <!-- data-z values: 0 = closest to viewer, negative = further back -->

  <div class="layer layer-bg" data-z="-400">
    <h2>Background</h2>
    <p>This layer is at z=−400. It barely moves as you shift the mouse.</p>
  </div>

  <div class="layer layer-mid" data-z="-200">
    <h2>Mid Layer</h2>
    <p>z=−200. Moves at roughly half the speed of the foreground.</p>
  </div>

  <div class="layer layer-fg" data-z="0">
    <h2>Foreground</h2>
    <p>z=0 (base plane). Move your mouse — layers behind this one shift backwards.</p>
    <p style="margin-top: 8px;">Built with <strong>planespace</strong>. Move your mouse to see depth.</p>
  </div>

</div>

<script type="module">
  import { Planespace } from './js/planespace.min.js';

  const ps = new Planespace({
    inputMode: 'mouse',
    maxAngle: 6,
    lerpFactor: 0.06,
    warpMode: '${warpMode}',
    depthRange: [-600, 100],
    shader: {
      warpStrength: 0.015,
      edgeClamping: true,
      chromaticOffset: false,
      vignetteStrength: 0.2,
      temporalSmoothing: 0.85,
    },
    compositor: {
      targetFPS: 60,
      skipIfDOMDirty: true,
    },
    debug: false,
  });

  await ps.mount(document.querySelector('.scene'));

  ps.on('ready', () => {
    console.log('[${name}] planespace ready — mode:', ps._warpMode);
  });
</script>
</body>
</html>
`;
}

function makePackageJson(name) {
  return JSON.stringify({
    name: name.toLowerCase().replace(/\s+/g, '-'),
    version: '0.1.0',
    description: `${name} — a planespace project`,
    type: 'module',
    scripts: {
      dev: 'planespace dev',
      audit: 'planespace audit index.html',
    },
    devDependencies: {
      'planespace-cli': '*',
    },
  }, null, 2) + '\n';
}

function makeReadme(name, warpMode) {
  return `# ${name}

A [planespace](https://github.com/planespace/planespace) project.

## Setup

\`\`\`bash
# Copy planespace.min.js into js/
cp node_modules/planespace/dist/planespace.min.js public/js/

# Start local dev server
npm run dev

# Audit HTML for depth issues
npm run audit
\`\`\`

## Depth layers

This project uses \`data-z\` attributes for depth. The coordinate system:

| Value    | Meaning                        |
|----------|--------------------------------|
| \`0\`    | Base plane (closest by default)|
| negative | Further from viewer            |
| positive | Closer than base (raised)      |

## Warp mode: \`${warpMode}\`

${warpMode === 'reproject'
  ? '**reproject** — uses WebGL2 shader + html2canvas to capture and warp the live DOM. Requires html2canvas to be loaded before planespace.'
  : '**transform** — uses CSS `translateZ` + `perspective`. No WebGL required. Fast and compatible.'}
`;
}

function makeGitignore() {
  return `node_modules/
.DS_Store
*.log
`;
}

// ── Main export ──────────────────────────────────────────────────────────────

export function init(projectName, opts = {}) {
  const warpMode = opts.mode || 'transform';
  const dir = resolve(projectName);

  console.log(`\n${bold('planespace init')} → ${cyan(projectName)}\n`);

  if (existsSync(dir)) {
    if (!opts.force) {
      console.error(`  Directory "${projectName}" already exists. Use --force to overwrite.\n`);
      process.exit(1);
    }
  }

  const files = [
    [dir, null],
    [join(dir, 'js'), null],
    [join(dir, 'index.html'), makeIndexHtml(projectName, warpMode)],
    [join(dir, 'package.json'), makePackageJson(projectName)],
    [join(dir, 'README.md'), makeReadme(projectName, warpMode)],
    [join(dir, '.gitignore'), makeGitignore()],
  ];

  for (const [path, content] of files) {
    if (content === null) {
      mkdirSync(path, { recursive: true });
      console.log(`  ${dim('dir')}   ${gray(path.replace(resolve('.') + '/', ''))}`);
    } else {
      writeFileSync(path, content, 'utf8');
      const rel = path.replace(resolve('.') + '/', '');
      console.log(`  ${green('+')}     ${rel}`);
    }
  }

  console.log();
  console.log(`  ${bold('Next steps:')}`);
  console.log(`    ${cyan(`cd ${projectName}`)}`);
  console.log(`    ${gray('# Copy planespace.min.js into js/')}`);
  console.log(`    ${cyan('planespace dev')}          ${gray('# start local server')}`);
  console.log(`    ${cyan('planespace audit index.html')} ${gray('# check for depth issues')}`);
  if (warpMode === 'reproject') {
    console.log();
    console.log(`  ${c.yellow}⚠  reproject mode requires html2canvas.${c.reset}`);
    console.log(`     ${gray('Add it before planespace or use --mode transform.')}`);
  }
  console.log();
}
