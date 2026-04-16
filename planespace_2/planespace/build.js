#!/usr/bin/env node
/**
 * Simple bundler: inlines all modules into a single ESM file.
 * No external dependencies required.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function bundle() {
  // Read all source files and inline them
  const files = [
    'src/core/EventEmitter.js',
    'src/core/DepthRegistry.js',
    'src/core/RenderLoop.js',
    'src/input/MouseInput.js',
    'src/input/GyroInput.js',
    'src/input/InputManager.js',
    'src/shader/WarpShader.js',
    'src/capture/CaptureStream.js',
    'src/capture/Html2canvas.js',
    'src/capture/CaptureManager.js',
    'src/layout/SpatialLayout.js',
    'src/core/PlanespaceCore.js',
    'src/core/Planespace.js',
  ];

  let output = `/**
 * planespace v1.0.0 — Perceptual 3D for the sovereign web
 * https://planespace.dev
 * MIT License
 */
`;

  for (const file of files) {
    const src = readFileSync(resolve(__dirname, file), 'utf-8');
    // Strip import statements (we're inlining everything)
    const stripped = src
      .replace(/^import\s+\{[^}]+\}\s+from\s+'[^']+';?\s*\n/gm, '')
      .replace(/^import\s+\*\s+as\s+\w+\s+from\s+'[^']+';?\s*\n/gm, '')
      .replace(/^import\s+'[^']+';?\s*\n/gm, '');
    output += stripped + '\n';
  }

  // Add named exports at the end
  output += `
export { Planespace, PlanespaceCore, DepthRegistry, RenderLoop, EventEmitter };
export { SpatialLayout };
export { WarpShader };
export { InputManager, MouseInput, GyroInput };
export { CaptureManager };
`;

  mkdirSync(resolve(__dirname, 'dist'), { recursive: true });
  writeFileSync(resolve(__dirname, 'dist/planespace.min.js'), output);
  console.log('✓ Built dist/planespace.min.js');
}

bundle();
