import { EventEmitter } from './EventEmitter.js';
import { DepthRegistry } from './DepthRegistry.js';
import { RenderLoop } from './RenderLoop.js';
import { InputManager } from '../input/InputManager.js';
import { WarpShader } from '../shader/WarpShader.js';
import { CaptureManager } from '../capture/CaptureManager.js';
import { validate, warn } from './DevTools.js';

/**
 * Planespace — DOM-native perceptual compositor.
 *
 * Adds believable parallax depth to standard HTML without layout mutation,
 * scene graph takeover, or forced WebGL dependency. Elements declare their
 * Z-position via `data-z` attributes; Planespace builds a live depth map
 * and warps the rendered frame per-pixel based on viewer position.
 *
 * @see https://github.com/planespace/planespace
 * @see SPEC.md for the full runtime contract and invariants.
 *
 * @example
 *   const ps = new Planespace({ maxAngle: 8, inputMode: 'mouse' });
 *   await ps.mount(document.body);
 *   ps.on('ready', () => console.log('depth warp active'));
 */
export class Planespace {
  // ─── Private state (never access these from outside) ─────────────────────
  #options;
  #emitter;
  #depthRegistry;
  #inputManager;
  #renderLoop;
  #captureManager;
  #shader;
  #outputCanvas;
  #root;
  #mounted;
  #paused;
  #firstFrame;
  #transformContainer;
  #warpMode;
  #resizeObserver;
  #lastDepthTexture;
  #frameCount;
  #startTime;

  constructor(options = {}) {
    this.#options = this.#mergeDefaults(options);
    this.#validate(this.#options);

    this.#emitter = new EventEmitter();
    this.#depthRegistry = new DepthRegistry({
      depthAttr: this.#options.depthAttr,
      depthRange: this.#options.depthRange,
      layers: this.#options.layers,
      emitter: this.#emitter,
    });
    this.#inputManager = new InputManager(this.#options);
    this.#renderLoop = new RenderLoop({
      targetFPS: this.#options.compositor.targetFPS,
      onFrame: this.#onFrame.bind(this),
    });
    this.#captureManager = new CaptureManager(this.#options);

    this.#shader = null;
    this.#outputCanvas = null;
    this.#root = null;
    this.#mounted = false;
    this.#paused = false;
    this.#firstFrame = false;
    this.#transformContainer = null;
    this.#lastDepthTexture = null;
    this.#frameCount = 0;
    this.#startTime = 0;

    // Determine warp mode with fallback
    this.#warpMode = this.#options.warpMode;
    if (this.#warpMode === 'reproject' && !WarpShader.isSupported()) {
      warn('WebGL2 not available — falling back to transform mode. ' +
        'For full parallax warp, use a browser that supports WebGL2.');
      this.#warpMode = 'transform';
    }
  }

  // ─── Public Getters ───────────────────────────────────────────────────────

  /** Whether planespace has been mounted. */
  get mounted() { return this.#mounted; }

  /** Whether the render loop is currently paused. */
  get paused() { return this.#paused; }

  /** Active warp mode: 'reproject' | 'transform' */
  get warpMode() { return this.#warpMode; }

  /** Number of frames rendered since mount. */
  get frameCount() { return this.#frameCount; }

  /** Current smoothed viewer position { x, y } in -1..1 range. */
  get viewer() { return this.#inputManager.current; }

  /** Current configuration snapshot (readonly copy). */
  get config() { return structuredClone(this.#options); }

  /** Number of registered depth elements. */
  get depthElementCount() { return this.#depthRegistry.entries.length; }

  /** Active capture strategy name, or null if not mounted. */
  get captureStrategy() { return this.#captureManager.currentStrategyName; }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Activate planespace on a DOM subtree.
   *
   * @param {Element} [root=document.body] - Root element to scan for [data-z] elements.
   * @returns {Promise<void>} Resolves once the first frame has been set up.
   * @fires ready
   */
  async mount(root = document.body) {
    if (this.#mounted) this.unmount();

    if (!root || !(root instanceof Element) && root !== document.body) {
      throw new TypeError('[planespace] mount() requires a valid DOM Element.');
    }

    this.#root = root;
    this.#frameCount = 0;
    this.#startTime = performance.now();

    // Scan for depth elements
    this.#depthRegistry.scan(root);

    if (this.#depthRegistry.entries.length === 0) {
      warn('No elements with [' + this.#options.depthAttr + '] found. ' +
        'Add data-z attributes to enable depth. ' +
        'See https://github.com/planespace/planespace#quickstart');
    }

    // Set up output canvas
    this.#outputCanvas = this.#options.outputCanvas || document.createElement('canvas');
    this.#setupOutputCanvas();

    if (this.#warpMode === 'transform') {
      this.#setupTransformMode(root);
    } else {
      await this.#setupReprojectionMode();
    }

    this.#inputManager.attach();
    this.#renderLoop.start();
    this.#mounted = true;
  }

  /**
   * Deactivate planespace, restore DOM, and release all resources.
   *
   * Safe to call multiple times.
   */
  unmount() {
    if (!this.#mounted) return;

    this.#renderLoop.stop();
    this.#inputManager.detach();
    this.#captureManager.destroy();

    if (this.#outputCanvas && this.#outputCanvas.parentNode) {
      this.#outputCanvas.parentNode.removeChild(this.#outputCanvas);
    }

    if (this.#resizeObserver) {
      this.#resizeObserver.disconnect();
      this.#resizeObserver = null;
    }

    if (this.#shader) {
      this.#shader.destroy();
      this.#shader = null;
    }

    if (this.#transformContainer) {
      this.#transformContainer.style.transform = '';
      this.#transformContainer.style.perspective = '';
      this.#transformContainer = null;
    }

    this.#depthRegistry.destroy();
    this.#emitter.removeAllListeners();
    this.#mounted = false;
    this.#firstFrame = false;
    this.#lastDepthTexture = null;
  }

  /**
   * Re-scan for [data-z] elements after dynamic DOM changes.
   * Call this after inserting or removing depth elements.
   */
  refresh() {
    if (this.#root) {
      this.#depthRegistry.scan(this.#root);
    }
  }

  /**
   * @deprecated Use refresh() instead. Will be removed in v2.0.
   */
  update() {
    warn('update() is deprecated — use refresh() instead. ' +
      'update() will be removed in planespace v2.0.');
    this.refresh();
  }

  /**
   * Manually override the viewer position.
   *
   * @param {number} x - Normalized X offset (-1..1). 0 = center.
   * @param {number} y - Normalized Y offset (-1..1). 0 = center.
   */
  setViewer(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new TypeError('[planespace] setViewer(x, y) requires two numbers.');
    }
    this.#inputManager.setViewer(x, y);
  }

  /**
   * Pause the render loop. No-op if already paused.
   */
  pause() {
    if (this.#paused) return;
    this.#paused = true;
    this.#renderLoop.stop();
    this.#emitter.emit('pause');
  }

  /**
   * Resume the render loop. No-op if not paused.
   */
  resume() {
    if (!this.#paused) return;
    this.#paused = false;
    this.#renderLoop.start();
    this.#emitter.emit('resume');
  }

  /**
   * Subscribe to a planespace event.
   *
   * Events: 'ready' | 'frame' | 'depthchange' | 'pause' | 'resume' | 'error'
   *
   * @param {string} event
   * @param {Function} handler
   * @returns {Function} Unsubscribe function — call to remove the listener.
   *
   * @example
   *   const off = ps.on('frame', ({ rx, ry }) => updateUI(rx, ry));
   *   // later:
   *   off(); // removes listener
   */
  on(event, handler) {
    const valid = ['ready', 'frame', 'depthchange', 'pause', 'resume', 'error'];
    if (!valid.includes(event)) {
      warn(`Unknown event "${event}". Valid events: ${valid.join(', ')}`);
    }
    return this.#emitter.on(event, handler);
  }

  /**
   * Set the Z-depth of an element programmatically.
   * Equivalent to setting element.setAttribute('data-z', z).
   *
   * @param {Element} el
   * @param {number} z - Depth in same units as depthRange.
   */
  setDepth(el, z) {
    if (!(el instanceof Element)) {
      throw new TypeError('[planespace] setDepth() requires a DOM Element.');
    }
    if (typeof z !== 'number' || isNaN(z)) {
      throw new TypeError('[planespace] setDepth() requires a finite number for z.');
    }
    this.#depthRegistry.setDepth(el, z);
  }

  /**
   * Update configuration at runtime. Only safe for non-structural options.
   * Structural options (warpMode, depthAttr) require unmount/remount.
   *
   * @param {Partial<PlanespaceOptions>} patch
   */
  configure(patch = {}) {
    const structural = ['warpMode', 'depthAttr'];
    for (const key of structural) {
      if (key in patch) {
        warn(`configure(): "${key}" is a structural option and requires unmount/remount to take effect.`);
      }
    }

    // Safely merge non-structural options
    if (patch.maxAngle !== undefined) this.#options.maxAngle = patch.maxAngle;
    if (patch.lerpFactor !== undefined) this.#options.lerpFactor = patch.lerpFactor;
    if (patch.inputDeadzone !== undefined) this.#options.inputDeadzone = patch.inputDeadzone;
    if (patch.debug !== undefined) this.#options.debug = patch.debug;

    // Forward to inputManager
    if (patch.maxAngle !== undefined || patch.lerpFactor !== undefined) {
      this.#inputManager.configure(this.#options);
    }
  }

  /**
   * Get a performance snapshot.
   * @returns {{ fps: number, frameCount: number, uptimeMs: number }}
   */
  getPerformanceMetrics() {
    const uptimeMs = this.#mounted ? performance.now() - this.#startTime : 0;
    const fps = uptimeMs > 0 ? (this.#frameCount / uptimeMs) * 1000 : 0;
    return {
      fps: Math.round(fps * 10) / 10,
      frameCount: this.#frameCount,
      uptimeMs: Math.round(uptimeMs),
    };
  }

  // ─── Private: Setup ───────────────────────────────────────────────────────

  #setupOutputCanvas() {
    const canvas = this.#outputCanvas;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = w;
    canvas.height = h;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.setAttribute('role', 'presentation');
    canvas.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: ${this.#options.outputZIndex};
    `;

    if (!canvas.parentNode) {
      document.body.appendChild(canvas);
    }

    this.#resizeObserver = new ResizeObserver(() => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    });
    this.#resizeObserver.observe(document.documentElement);
  }

  async #setupReprojectionMode() {
    this.#shader = new WarpShader(this.#outputCanvas, this.#options);
    try {
      this.#shader.init();
    } catch (err) {
      warn('WarpShader init failed — falling back to transform mode. ' + err.message);
      this.#warpMode = 'transform';
      this.#shader = null;
      this.#setupTransformMode(this.#root);
      return;
    }

    const w = this.#outputCanvas.width;
    const h = this.#outputCanvas.height;
    await this.#captureManager.init(w, h, this.#root);
  }

  #setupTransformMode(root) {
    let container = root;
    if (container.tagName === 'BODY') {
      container = document.documentElement;
    }
    this.#transformContainer = container;
    container.style.perspective = `${this.#options.perspective}px`;
    container.style.transformStyle = 'preserve-3d';
    this.#applyTransformDepths();
  }

  #applyTransformDepths() {
    if (!this.#depthRegistry) return;
    for (const { el, z } of this.#depthRegistry.entries) {
      el.style.transform = `translateZ(${z}px)`;
      el.style.transformStyle = 'preserve-3d';
    }
  }

  // ─── Private: Render loop ─────────────────────────────────────────────────

  async #onFrame(timestamp) {
    const { x: rx, y: ry } = this.#inputManager.tick();

    if (this.#warpMode === 'transform') {
      this.#renderTransformFrame(rx, ry);
    } else {
      await this.#renderReprojectionFrame(rx, ry, timestamp);
    }

    this.#frameCount++;
    this.#emitter.emit('frame', { rx, ry, timestamp, frameCount: this.#frameCount });

    if (!this.#firstFrame) {
      this.#firstFrame = true;
      this.#emitter.emit('ready');
    }

    if (this.#options.debug) {
      this.#renderDebugOverlay(rx, ry);
    }
  }

  #renderTransformFrame(rx, ry) {
    if (!this.#transformContainer) return;
    const maxAngle = this.#options.maxAngle;
    const rotY = rx * maxAngle;
    const rotX = -ry * maxAngle;
    this.#transformContainer.style.transform =
      `perspective(${this.#options.perspective}px) rotateY(${rotY}deg) rotateX(${rotX}deg)`;
  }

  async #renderReprojectionFrame(rx, ry, timestamp) {
    if (!this.#shader) return;

    const bitmap = await this.#captureManager.captureFrame();
    if (bitmap) {
      this.#shader.uploadScene(bitmap);
    }

    if (this.#depthRegistry.isDirty || !this.#lastDepthTexture) {
      const w = this.#outputCanvas.width;
      const h = this.#outputCanvas.height;
      this.#lastDepthTexture = this.#depthRegistry.generateDepthTexture(w, h);
      this.#shader.uploadDepth(this.#lastDepthTexture);
    }

    this.#shader.render(rx, ry);
  }

  #renderDebugOverlay(rx, ry) {
    const ctx = this.#outputCanvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillRect(10, 10, 280, 100);
    ctx.fillStyle = '#00ff88';
    ctx.font = '11px "SF Mono", "Fira Code", monospace';
    ctx.fillText(`planespace [${this.#warpMode}]`, 20, 30);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(`viewer: x=${rx.toFixed(3)}  y=${ry.toFixed(3)}`, 20, 48);
    ctx.fillText(`depth elements: ${this.#depthRegistry.entries.length}`, 20, 66);
    ctx.fillText(`capture: ${this.#captureManager.currentStrategyName || '—'}`, 20, 84);
    const m = this.getPerformanceMetrics();
    ctx.fillText(`fps: ~${m.fps}  frames: ${m.frameCount}`, 20, 100);
    ctx.restore();
  }

  // ─── Private: Config & Validation ────────────────────────────────────────

  #mergeDefaults(opts) {
    return {
      inputMode: opts.inputMode || 'mouse',
      maxAngle: opts.maxAngle !== undefined ? opts.maxAngle : 6,
      lerpFactor: opts.lerpFactor !== undefined ? opts.lerpFactor : 0.06,
      inputDeadzone: opts.inputDeadzone !== undefined ? opts.inputDeadzone : 0.03,
      depthAttr: opts.depthAttr || 'data-z',
      depthRange: opts.depthRange || [-600, 100],
      layers: opts.layers || {},
      warpMode: opts.warpMode || 'reproject',
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
      compositor: {
        targetFPS: 60,
        captureResolution: 1.0,
        skipIfDOMDirty: true,
        strategy: 'auto',
        ...(opts.compositor || {}),
      },
      perspective: opts.perspective !== undefined ? opts.perspective : 900,
      outputCanvas: opts.outputCanvas || null,
      outputZIndex: opts.outputZIndex !== undefined ? opts.outputZIndex : 2147483647,
      gyro: {
        sensitivity: 0.8,
        axes: 'beta-gamma',
        calibrateOnMount: true,
        ...(opts.gyro || {}),
      },
      debug: opts.debug || false,
    };
  }

  #validate(opts) {
    validate(
      ['mouse', 'gyro', 'both', 'none'].includes(opts.inputMode),
      `inputMode must be 'mouse' | 'gyro' | 'both' | 'none'. Got: "${opts.inputMode}"`
    );
    validate(
      opts.maxAngle > 0 && opts.maxAngle <= 90,
      `maxAngle must be between 0 and 90 degrees. Got: ${opts.maxAngle}`
    );
    validate(
      opts.lerpFactor >= 0 && opts.lerpFactor <= 1,
      `lerpFactor must be 0–1. Got: ${opts.lerpFactor}`
    );
    validate(
      Array.isArray(opts.depthRange) && opts.depthRange.length === 2,
      'depthRange must be a [min, max] tuple.'
    );
    validate(
      opts.depthRange[0] < opts.depthRange[1],
      `depthRange[0] must be less than depthRange[1]. Got: [${opts.depthRange}]`
    );
    validate(
      ['reproject', 'transform', 'hybrid'].includes(opts.warpMode),
      `warpMode must be 'reproject' | 'transform' | 'hybrid'. Got: "${opts.warpMode}"`
    );
    validate(
      opts.compositor.captureResolution > 0 && opts.compositor.captureResolution <= 2,
      `compositor.captureResolution must be 0–2. Got: ${opts.compositor.captureResolution}`
    );

    if (opts.maxAngle > 15) {
      warn(`maxAngle of ${opts.maxAngle}° is very high. Values above 12° may cause visible warping artifacts.`);
    }
    if (opts.lerpFactor > 0.3) {
      warn(`lerpFactor of ${opts.lerpFactor} will feel snappy. For smooth following, try 0.04–0.10.`);
    }
  }
}
