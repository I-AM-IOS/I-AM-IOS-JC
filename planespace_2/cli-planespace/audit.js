/**
 * planespace audit
 * Analyzes an HTML file for depth issues based on actual planespace source behavior.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── ANSI colors ──────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  red:   '\x1b[31m',
  yellow:'\x1b[33m',
  green: '\x1b[32m',
  cyan:  '\x1b[36m',
  gray:  '\x1b[90m',
};
const bold   = s => `${c.bold}${s}${c.reset}`;
const red    = s => `${c.red}${s}${c.reset}`;
const yellow = s => `${c.yellow}${s}${c.reset}`;
const green  = s => `${c.green}${s}${c.reset}`;
const cyan   = s => `${c.cyan}${s}${c.reset}`;
const gray   = s => `${c.gray}${s}${c.reset}`;
const dim    = s => `${c.dim}${s}${c.reset}`;

// ── Minimal HTML parser (no deps) ────────────────────────────────────────────
function parseDataZElements(html, depthAttr = 'data-z') {
  const results = [];
  // Match opening tags with data-z attribute
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  const attrRe = new RegExp(`${depthAttr}\\s*=\\s*["']?([^"'\\s>]+)["']?`);

  let lineNum = 1;
  let lastIndex = 0;

  for (const match of html.matchAll(tagRe)) {
    // Count lines up to this point
    lineNum = (html.slice(0, match.index).match(/\n/g) || []).length + 1;

    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const zMatch = attrRe.exec(attrs);
    if (zMatch) {
      results.push({ tag, raw: zMatch[1], index: match.index, line: lineNum, fullMatch: match[0] });
    }
  }
  return results;
}

function extractPlanespaceConfig(html) {
  // Look for new Planespace({ ... }) calls — extract depthRange, layers, warpMode
  const config = { depthRange: [-600, 100], layers: {}, warpMode: 'reproject', depthAttr: 'data-z' };

  // depthRange
  const drMatch = html.match(/depthRange\s*:\s*\[([^\]]+)\]/);
  if (drMatch) {
    const parts = drMatch[1].split(',').map(s => parseFloat(s.trim()));
    if (parts.length === 2 && !parts.some(isNaN)) config.depthRange = parts;
  }

  // warpMode
  const wmMatch = html.match(/warpMode\s*:\s*['"]([^'"]+)['"]/);
  if (wmMatch) config.warpMode = wmMatch[1];

  // depthAttr
  const daMatch = html.match(/depthAttr\s*:\s*['"]([^'"]+)['"]/);
  if (daMatch) config.depthAttr = daMatch[1];

  // layers (named z-layers)
  const layersMatch = html.match(/layers\s*:\s*\{([^}]+)\}/);
  if (layersMatch) {
    const layerRe = /['"]?(\w+)['"]?\s*:\s*(-?\d+(?:\.\d+)?)/g;
    for (const m of layersMatch[1].matchAll(layerRe)) {
      config.layers[m[1]] = parseFloat(m[2]);
    }
  }

  // html2canvas
  config.hasHtml2canvas = /html2canvas/i.test(html);

  return config;
}

function resolveZ(raw, layers) {
  if (layers[raw] !== undefined) return { z: layers[raw], isNamed: true, name: raw };
  const n = parseFloat(raw);
  if (isNaN(n)) return { z: 0, isInvalid: true, raw };
  return { z: n, isNamed: false };
}

// ── Check functions ──────────────────────────────────────────────────────────

function checkNoElements(elements) {
  if (elements.length === 0) {
    return { level: 'error', code: 'NO_DEPTH_ELEMENTS',
      message: 'No elements with data-z attribute found.',
      detail: 'planespace does nothing without at least one [data-z] element. Add data-z to any element to give it a depth value.' };
  }
  return null;
}

function checkOutOfRange(elements, config) {
  const issues = [];
  const [min, max] = config.depthRange;
  for (const el of elements) {
    const { z, isInvalid, isNamed } = resolveZ(el.raw, config.layers);
    if (isInvalid) {
      issues.push({ level: 'error', code: 'INVALID_Z_VALUE', line: el.line,
        message: `<${el.tag}> has unparseable data-z="${el.raw}".`,
        detail: `parseFloat("${el.raw}") returns NaN. planespace will silently treat this as z=0. Provide a number or a defined layer name.` });
      continue;
    }
    if (!isNamed && (z < min - 50 || z > max + 50)) {
      issues.push({ level: 'warning', code: 'Z_OUT_OF_DEPTHRANGE', line: el.line,
        message: `<${el.tag}> z=${z} is outside depthRange [${min}, ${max}].`,
        detail: `The depth texture normalizes z to 0..1 using depthRange. A value outside this range clamps to 0 or 1, flattening the element against the depth extremes. Either expand depthRange or adjust the z value.` });
    }
  }
  return issues;
}

function checkExtremeDistortion(elements, config) {
  const issues = [];
  for (const el of elements) {
    const { z, isInvalid } = resolveZ(el.raw, config.layers);
    if (isInvalid) continue;
    if (Math.abs(z) > 800) {
      issues.push({ level: 'warning', code: 'EXTREME_Z_VALUE', line: el.line,
        message: `<${el.tag}> z=${z} exceeds ±800px — expect extreme distortion.`,
        detail: 'Values beyond ±800 produce heavily warped pixels at normal warpStrength. This may be intentional, but consider using a lower warpStrength if the effect is too aggressive.' });
    }
  }
  return issues;
}

function checkDepthCollisions(elements, config) {
  // Group elements by resolved z value — same z is fine but large clusters may indicate forgotten annotations
  const byZ = new Map();
  for (const el of elements) {
    const { z, isInvalid } = resolveZ(el.raw, config.layers);
    if (isInvalid) continue;
    if (!byZ.has(z)) byZ.set(z, []);
    byZ.get(z).push(el);
  }
  const issues = [];
  for (const [z, els] of byZ.entries()) {
    if (els.length > 6) {
      issues.push({ level: 'info', code: 'MANY_ELEMENTS_SAME_DEPTH',
        message: `${els.length} elements share z=${z}. This is fine but consider if some should differ.`,
        detail: 'In reproject mode, overlapping elements at the same z shift identically so they feel flat relative to each other. This is only an issue if you wanted separation between them.' });
    }
  }
  return issues;
}

function checkDepthInheritanceGap(html, elements, config) {
  // Find elements with data-z children but no data-z themselves
  // Simplified: find divs that contain data-z children — warn if outer has no data-z
  // (In reproject mode children without data-z get NO depth in the texture)
  const issues = [];

  if (config.warpMode === 'reproject' || config.warpMode === 'hybrid') {
    // Check: any element whose content includes child data-z but is itself not data-z
    // This is hard without a real DOM, so we look for common patterns:
    // A tag that wraps another tag with data-z but itself has no data-z
    const outerTagRe = /<(div|section|article|main|aside|header|footer)([^>]*)>([\s\S]*?)<\/\1>/gi;
    for (const match of html.matchAll(outerTagRe)) {
      const outerAttrs = match[2];
      const outerContent = match[3];
      const hasOwnZ = new RegExp(config.depthAttr).test(outerAttrs);
      const hasChildZ = new RegExp(`${config.depthAttr}\\s*=`).test(outerContent);
      if (!hasOwnZ && hasChildZ) {
        const lineNum = (html.slice(0, match.index).match(/\n/g) || []).length + 1;
        issues.push({ level: 'warning', code: 'DEPTH_INHERITANCE_REPROJECT_GAP', line: lineNum,
          message: `<${match[1]}> wraps [data-z] children but has no depth itself (line ~${lineNum}).`,
          detail: `In reproject mode, depth inheritance is a CSS illusion — only elements with explicit [data-z] appear in the depth texture. The wrapper's own pixels get z=0 in T_depth. In transform mode this works fine. If you're using reproject, add data-z to the wrapper or accept that it renders at z=0.` });
        if (issues.length >= 3) break; // Don't flood
      }
    }
  }
  return issues;
}

function checkReprojectionCapture(html, config) {
  const issues = [];
  if (config.warpMode === 'reproject' || config.warpMode === 'auto') {
    if (!config.hasHtml2canvas) {
      issues.push({ level: 'error', code: 'REPROJECT_NO_CAPTURE_STRATEGY',
        message: 'warpMode is "reproject" but html2canvas is not loaded.',
        detail: `The actual planespace source checks for window.html2canvas and silently falls back to transform mode if it's absent. The documented "captureStream" Strategy A is not implemented. To use reproject mode, add html2canvas before planespace:\n  <script src="https://html2canvas.hertzen.com/dist/html2canvas.min.js"></script>` });
    }
  }
  return issues;
}

function checkUndefinedLayerNames(elements, config) {
  const issues = [];
  for (const el of elements) {
    const raw = el.raw;
    const n = parseFloat(raw);
    if (!isNaN(n)) continue; // It's a number, fine
    if (config.layers[raw] === undefined) {
      issues.push({ level: 'error', code: 'UNDEFINED_LAYER_NAME', line: el.line,
        message: `<${el.tag}> uses named layer "${raw}" which is not defined in layers config.`,
        detail: `planespace._resolveZ("${raw}") will fall through to parseFloat("${raw}") which returns NaN, then default to z=0. Define this layer: layers: { "${raw}": <value> }` });
    }
  }
  return issues;
}

function checkSingleDepthLayer(elements, config) {
  if (elements.length < 2) return [];
  const zValues = new Set(elements.map(el => resolveZ(el.raw, config.layers).z));
  if (zValues.size === 1) {
    return [{ level: 'warning', code: 'ALL_SAME_DEPTH',
      message: `All ${elements.length} elements share the same z value — no parallax will be visible.`,
      detail: 'planespace needs depth variation to produce the parallax effect. Spread elements across different z values.' }];
  }
  return [];
}

function checkDebugOnProduction(html) {
  if (/debug\s*:\s*true/.test(html)) {
    return [{ level: 'info', code: 'DEBUG_ENABLED',
      message: 'debug: true is set — the debug overlay will show in production.',
      detail: 'The debug overlay only renders in transform mode (there is a guard in _drawDebug that returns early in reproject mode). Remove debug: true before shipping.' }];
  }
  return [];
}

function checkLerpFactor(html) {
  const m = html.match(/lerpFactor\s*:\s*([\d.]+)/);
  if (!m) return [];
  const v = parseFloat(m[1]);
  if (v > 0.25) {
    return [{ level: 'warning', code: 'HIGH_LERP_FACTOR',
      message: `lerpFactor: ${v} is very high — camera movement will feel snappy / jittery.`,
      detail: 'The InputManager tick() multiplies lerpFactor by 10 before clamping to 1. A lerpFactor of 0.1 or higher produces near-instant response with no smoothing. Default is 0.06.' }];
  }
  return [];
}

// ── Formatter ────────────────────────────────────────────────────────────────

function formatIssue(issue, idx) {
  const icon = issue.level === 'error' ? red('✖') : issue.level === 'warning' ? yellow('⚠') : cyan('ℹ');
  const lineStr = issue.line ? gray(` (line ${issue.line})`) : '';
  const lines = [
    `  ${icon}  ${bold(issue.code)}${lineStr}`,
    `     ${issue.message}`,
    `     ${dim(issue.detail)}`,
  ];
  return lines.join('\n');
}

// ── Main export ──────────────────────────────────────────────────────────────

export function audit(filePath, opts = {}) {
  const absPath = resolve(filePath);
  let html;
  try {
    html = readFileSync(absPath, 'utf8');
  } catch (e) {
    console.error(red(`Cannot read file: ${absPath}`));
    process.exit(1);
  }

  const config = extractPlanespaceConfig(html);
  const depthAttr = opts.depthAttr || config.depthAttr;
  const elements = parseDataZElements(html, depthAttr);

  console.log(`\n${bold('planespace audit')} ${gray('→')} ${cyan(filePath)}\n`);
  console.log(`  ${gray('depthRange:')}  [${config.depthRange.join(', ')}]`);
  console.log(`  ${gray('warpMode:')}    ${config.warpMode}`);
  console.log(`  ${gray('depthAttr:')}   ${depthAttr}`);
  console.log(`  ${gray('layers:')}      ${Object.keys(config.layers).length ? JSON.stringify(config.layers) : '(none)'}`);
  console.log(`  ${gray('html2canvas:')} ${config.hasHtml2canvas ? green('found') : red('not found')}`);
  console.log(`  ${gray('elements:')}    ${elements.length} [${depthAttr}] found`);
  console.log();

  // Run all checks
  const allIssues = [];

  const noElCheck = checkNoElements(elements);
  if (noElCheck) allIssues.push(noElCheck);

  allIssues.push(
    ...checkReprojectionCapture(html, config),
    ...checkOutOfRange(elements, config),
    ...checkExtremeDistortion(elements, config),
    ...checkUndefinedLayerNames(elements, config),
    ...checkSingleDepthLayer(elements, config),
    ...checkDepthCollisions(elements, config),
    ...checkDepthInheritanceGap(html, elements, config),
    ...checkDebugOnProduction(html),
    ...checkLerpFactor(html),
  );

  const errors   = allIssues.filter(i => i.level === 'error');
  const warnings = allIssues.filter(i => i.level === 'warning');
  const infos    = allIssues.filter(i => i.level === 'info');

  if (allIssues.length === 0) {
    console.log(`  ${green('✔')}  No issues found.\n`);
    return;
  }

  for (const issue of allIssues) {
    console.log(formatIssue(issue));
    console.log();
  }

  // Summary
  const parts = [];
  if (errors.length)   parts.push(red(`${errors.length} error${errors.length > 1 ? 's' : ''}`));
  if (warnings.length) parts.push(yellow(`${warnings.length} warning${warnings.length > 1 ? 's' : ''}`));
  if (infos.length)    parts.push(cyan(`${infos.length} info`));

  console.log(`  ${bold('Result:')} ${parts.join('  ')}\n`);

  if (errors.length > 0) process.exitCode = 1;
}
