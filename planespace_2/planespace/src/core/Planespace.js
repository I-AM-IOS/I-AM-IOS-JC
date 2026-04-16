import { EventEmitter } from './EventEmitter.js';
import { DepthRegistry } from './DepthRegistry.js';
import { RenderLoop } from './RenderLoop.js';
import { InputManager } from '../input/InputManager.js';
import { WarpShader } from '../shader/WarpShader.js';
import { CaptureManager } from '../capture/CaptureManager.js';

/**
 * Planespace — main class, public API
 *
 * Adds perceptual depth to standard HTML by applying a viewport-dependent
 * warp to the rendered page based on authored data-z depth metadata.
 */
export class Planespace {
  constructor(options = {}) {
    this._options = this._mergeDefaults(options);
    this._emitter = new EventEmitter();
    this._depthRegistry = new DepthRegistry({
      depthAttr: this._options.depthAttr,
      depthRange: this._options.depthRange,
      layers: this._options.layers,
      emitter: this._emitter,
    });
    this._inputManager = new InputManager(this._options);
    this._renderLoop = new RenderLoop({
      targetFPS: this._options.compositor.targetFPS,
      onFrame: this._onFrame.bind(this),
    });
    this._captureManager = new CaptureManager(this._options);
    this._shader = null;
    this._outputCanvas = null;
    this._root = null;
    this._mounted = false;
    this._paused = false;
    this._firstFrame = false;
    this._transformContainer = null;

    // Determine warp mode
    this._warpMode = this._options.warpMode;
    if (this._warpMode === 'reproject' && !WarpShader.isSupported()) {
      console.warn('[planespace] WebGL2 not available, falling back to transform mode');
      this._warpMode = 'transform';
    }
  }

  _mergeDefaults(opts) {
    return {
      // Input
      inputMode: opts.inputMode || 'mouse',
      maxAngle: opts.maxAngle !== undefined ? opts.maxAngle : 6,
      lerpFactor: opts.lerpFactor !== undefined ? opts.lerpFactor : 0.06,
      inputDeadzone: opts.inputDeadzone !== undefined ? opts.inputDeadzone : 0.03,

      // Depth
      depthAttr: opts.depthAttr || 'data-z',
      depthRange: opts.depthRange || [-600, 100],
      layers: opts.layers || {},

      // Warp
      warpMode: opts.warpMode || 'reproject',

      // Shader
      shader: {
        warpStrength: 0.015,
        edgeClamping: true,
        chromaticOffset: false,
        chromaticStrength: 0.002,
        vignetteStrength: 0.3,
        temporalSmoothing: 0.85,
        fragment: null,
        ...(opts.shader || {}),
      },

      // Compositor
      compositor: {
        targetFPS: 60,
        captureResolution: 1.0,
        skipIfDOMDirty: true,
        strategy: 'auto',
        ...(opts.compositor || {}),
      },

      // CSS perspective
      perspective: opts.perspective !== undefined ? opts.perspective : 900,

      // Output canvas
      outputCanvas: opts.outputCanvas || null,
      outputZIndex: opts.outputZIndex !== undefined ? opts.outputZIndex : 2147483647,

      // Gyro
      gyro: {
        sensitivity: 0.8,
        axes: 'beta-gamma',
        calibrateOnMount: true,
        ...(opts.gyro || {}),
      },

      // Debug
      debug: opts.debug || false,
    };
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Activate planespace on the document or a subtree.
   */
  async mount(root = document.body) {
    if (this._mounted) this.unmount();

    this._root = root;

    // Scan for depth elements
    this._depthRegistry.scan(root);

    // Set up output canvas
    this._outputCanvas = this._options.outputCanvas || document.createElement('canvas');
    this._setupOutputCanvas();

    if (this._warpMode === 'transform') {
      this._setupTransformMode(root);
    } else {
      // reproject or hybrid
      await this._setupReprojectionMode();
    }

    // Start input
    this._inputManager.attach();

    // Start render loop
    this._renderLoop.start();

    this._mounted = true;
  }

  /**
   * Remove the output canvas, stop render loop, detach listeners.
   */
  unmount() {
    if (!this._mounted) return;

    this._renderLoop.stop();
    this._inputManager.detach();
    this._captureManager.destroy();

    if (this._outputCanvas && this._outputCanvas.parentNode) {
      this._outputCanvas.parentNode.removeChild(this._outputCanvas);
    }

    if (this._shader) {
      this._shader.destroy();
      this._shader = null;
    }

    if (this._transformContainer) {
      // Restore original positioning
      this._transformContainer.style.transform = '';
      this._transformContainer.style.perspective = '';
      this._transformContainer = null;
    }

    this._depthRegistry.destroy();
    this._emitter.removeAllListeners();
    this._mounted = false;
    this._firstFrame = false;
  }

  /**
   * Re-scan for [data-z] elements after dynamic DOM changes.
   */
  update() {
    if (this._root) {
      this._depthRegistry.scan(this._root);
    }
  }

  /**
   * Manually set normalized viewer offset (-1..1).
   */
  setViewer(x, y) {
    this._inputManager.setViewer(x, y);
  }

  /**
   * Pause the render loop.
   */
  pause() {
    if (this._paused) return;
    this._paused = true;
    this._renderLoop.stop();
    this._emitter.emit('pause');
  }

  /**
   * Resume the render loop.
   */
  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._renderLoop.start();
    this._emitter.emit('resume');
  }

  /**
   * Subscribe to events.
   * @returns Unsubscribe function
   */
  on(event, handler) {
    return this._emitter.on(event, handler);
  }

  /**
   * Set depth of an element programmatically (batched within a frame).
   */
  setDepth(el, z) {
    this._depthRegistry.setDepth(el, z);
  }

  // ─── Private: Setup ──────────────────────────────────────────────────────

  _setupOutputCanvas() {
    const canvas = this._outputCanvas;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: ${this._options.outputZIndex};
    `;

    if (!canvas.parentNode) {
      document.body.appendChild(canvas);
    }

    // Keep canvas sized to viewport
    this._resizeObserver = new ResizeObserver(() => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    });
    this._resizeObserver.observe(document.documentElement);
  }

  async _setupReprojectionMode() {
    // Init shader on output canvas
    this._shader = new WarpShader(this._outputCanvas, this._options);
    try {
      this._shader.init();
    } catch (err) {
      console.warn('[planespace] WarpShader init failed, falling back to transform:', err);
      this._warpMode = 'transform';
      this._shader = null;
      this._setupTransformMode(this._root);
      return;
    }

    // Init capture pipeline
    const w = this._outputCanvas.width;
    const h = this._outputCanvas.height;
    await this._captureManager.init(w, h, this._root);
  }

  _setupTransformMode(root) {
    // Wrap root in a perspective container if not already
    let container = root;
    if (container.tagName === 'BODY') {
      container = document.documentElement;
    }

    this._transformContainer = container;
    container.style.perspective = `${this._options.perspective}px`;
    container.style.transformStyle = 'preserve-3d';

    // Apply initial Z transforms to depth elements
    this._applyTransformDepths();
  }

  _applyTransformDepths() {
    if (!this._depthRegistry) return;
    for (const { el, z } of this._depthRegistry.entries) {
      el.style.transform = `translateZ(${z}px)`;
      el.style.transformStyle = 'preserve-3d';
    }
  }

  // ─── Private: Render loop ────────────────────────────────────────────────

  async _onFrame(timestamp) {
    const { x: rx, y: ry } = this._inputManager.tick();

    if (this._warpMode === 'transform') {
      this._renderTransformFrame(rx, ry);
    } else {
      await this._renderReprojectionFrame(rx, ry, timestamp);
    }

    this._emitter.emit('frame', { rx, ry, timestamp });

    if (!this._firstFrame) {
      this._firstFrame = true;
      this._emitter.emit('ready');
    }

    if (this._options.debug) {
      this._renderDebugOverlay(rx, ry);
    }
  }

  _renderTransformFrame(rx, ry) {
    if (!this._transformContainer) return;
    const maxAngle = this._options.maxAngle;

    // Tilt the scene container based on viewer angle
    const rotY = rx * maxAngle;
    const rotX = -ry * maxAngle;

    this._transformContainer.style.transform =
      `perspective(${this._options.perspective}px) rotateY(${rotY}deg) rotateX(${rotX}deg)`;
  }

  async _renderReprojectionFrame(rx, ry, timestamp) {
    if (!this._shader) return;

    // Capture scene
    const bitmap = await this._captureManager.captureFrame();
    if (bitmap) {
      this._shader.uploadScene(bitmap);
    }

    // Generate or update depth texture if dirty
    if (this._depthRegistry.isDirty || !this._lastDepthTexture) {
      const w = this._outputCanvas.width;
      const h = this._outputCanvas.height;
      this._lastDepthTexture = this._depthRegistry.generateDepthTexture(w, h);
      this._shader.uploadDepth(this._lastDepthTexture);
    }

    // Render warped output
    this._shader.render(rx, ry);
  }

  _renderDebugOverlay(rx, ry) {
    // In transform mode, draw debug info on output canvas
    // In reproject mode, overlay on top
    const ctx = this._outputCanvas.getContext('2d');
    if (!ctx) return;

    const w = this._outputCanvas.width;
    const h = this._outputCanvas.height;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(10, 10, 260, 80);
    ctx.fillStyle = '#0f0';
    ctx.font = '12px monospace';
    ctx.fillText(`planespace [${this._warpMode}]`, 20, 30);
    ctx.fillText(`viewer: x=${rx.toFixed(3)} y=${ry.toFixed(3)}`, 20, 50);
    ctx.fillText(`depth elements: ${this._depthRegistry.entries.length}`, 20, 70);
    ctx.restore();
  }
}
