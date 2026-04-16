/**
 * planespace — DOM-native perceptual compositor.
 * TypeScript definitions.
 *
 * @version 1.0.0
 * @see https://github.com/planespace/planespace
 */

// ─── Option Types ─────────────────────────────────────────────────────────────

export interface ShaderOptions {
  /** UV-space warp strength per depth unit. Default: 0.015 */
  warpStrength?: number;
  /** Clamp UVs to prevent edge wrap artifacts. Default: true */
  edgeClamping?: boolean;
  /** Enable RGB channel split on near-plane elements. Default: false */
  chromaticOffset?: boolean;
  /** Chromatic aberration strength. Default: 0.002 */
  chromaticStrength?: number;
  /** Edge darkening at extreme viewer angles. 0 = off. Default: 0.3 */
  vignetteStrength?: number;
  /** Temporal depth-map blending factor. 0 = no smoothing. Default: 0.85 */
  temporalSmoothing?: number;
  /** Custom GLSL fragment shader source. Must declare same uniforms as built-in. */
  fragment?: string | null;
}

export interface CompositorOptions {
  /** Target frames per second. Default: 60 */
  targetFPS?: number;
  /** Scene capture resolution multiplier (0.5 = half res). Default: 1.0 */
  captureResolution?: number;
  /** Skip frame capture if DOM is pending a layout change. Default: true */
  skipIfDOMDirty?: boolean;
  /** Explicit capture strategy. Default: 'auto' */
  strategy?: 'auto' | 'captureStream' | 'html2canvas' | 'transform';
}

export interface GyroOptions {
  /** Input sensitivity multiplier. Default: 0.8 */
  sensitivity?: number;
  /** Which device axes to map to X/Y. Default: 'beta-gamma' */
  axes?: 'beta-gamma' | 'alpha-beta';
  /** Set the current orientation as neutral on first event. Default: true */
  calibrateOnMount?: boolean;
}

export interface PlanespaceOptions {
  /**
   * Input source.
   * - 'mouse' — desktop cursor position
   * - 'gyro' — device orientation (mobile)
   * - 'both' — auto-selects by device type
   * - 'none' — programmatic only via setViewer()
   * @default 'mouse'
   */
  inputMode?: 'mouse' | 'gyro' | 'both' | 'none';

  /**
   * Maximum scene tilt angle in degrees.
   * @default 6
   */
  maxAngle?: number;

  /**
   * Camera smoothing factor. 0 = instant tracking, 1 = no movement.
   * Recommended range: 0.04–0.12
   * @default 0.06
   */
  lerpFactor?: number;

  /**
   * Dead zone radius at center (normalized 0–1).
   * Mouse must move past this before any parallax activates.
   * @default 0.03
   */
  inputDeadzone?: number;

  /**
   * HTML attribute name used to declare element depth.
   * @default 'data-z'
   */
  depthAttr?: string;

  /**
   * [min, max] depth range in same units as data-z values.
   * @default [-600, 100]
   */
  depthRange?: [number, number];

  /**
   * Named depth layer aliases. e.g. { sky: -600, ground: 0, hud: 100 }
   * Use as: data-z="sky"
   */
  layers?: Record<string, number>;

  /**
   * Render strategy.
   * - 'reproject' — per-pixel warp via WebGL2 shader (best quality)
   * - 'transform' — CSS preserve-3d fallback (good for simple scenes)
   * - 'hybrid' — reproject where supported, transform fallback
   * @default 'reproject'
   */
  warpMode?: 'reproject' | 'transform' | 'hybrid';

  /** Shader configuration (reproject mode). */
  shader?: ShaderOptions;

  /** Compositor / capture configuration. */
  compositor?: CompositorOptions;

  /**
   * CSS perspective depth in pixels (transform mode).
   * @default 900
   */
  perspective?: number;

  /** Provide an existing canvas element as the output surface. */
  outputCanvas?: HTMLCanvasElement | null;

  /**
   * z-index of the output canvas overlay.
   * @default 2147483647
   */
  outputZIndex?: number;

  /** Gyroscope configuration (gyro / both inputMode). */
  gyro?: GyroOptions;

  /**
   * Show the development debug overlay.
   * @default false
   */
  debug?: boolean;
}

// ─── Event Types ──────────────────────────────────────────────────────────────

export interface FrameEvent {
  /** Normalized X viewer position (-1..1) */
  rx: number;
  /** Normalized Y viewer position (-1..1) */
  ry: number;
  /** requestAnimationFrame timestamp */
  timestamp: number;
  /** Total frames rendered since mount */
  frameCount: number;
}

export interface DepthChangeEvent {
  element: Element;
  oldZ: number | null;
  newZ: number;
}

export interface PerformanceMetrics {
  /** Average frames per second since mount */
  fps: number;
  /** Total frames rendered since mount */
  frameCount: number;
  /** Milliseconds since mount() resolved */
  uptimeMs: number;
}

// ─── Main Class ───────────────────────────────────────────────────────────────

export declare class Planespace {
  constructor(options?: PlanespaceOptions);

  // ─── Getters ──────────────────────────────────────────────────────────────

  /** Whether planespace is currently mounted. */
  readonly mounted: boolean;

  /** Whether the render loop is currently paused. */
  readonly paused: boolean;

  /** Active warp mode after capability detection. */
  readonly warpMode: 'reproject' | 'transform' | 'hybrid';

  /** Total frames rendered since mount. */
  readonly frameCount: number;

  /** Current smoothed viewer position in -1..1 range. */
  readonly viewer: { x: number; y: number };

  /** A read-only snapshot of the current configuration. */
  readonly config: Required<PlanespaceOptions>;

  /** Number of [data-z] elements currently tracked. */
  readonly depthElementCount: number;

  /** Active frame capture strategy, or null if not mounted. */
  readonly captureStrategy: string | null;

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Activate planespace on a DOM subtree.
   * Scans for [data-z] elements, sets up the capture pipeline, and starts rendering.
   *
   * @param root - Root element to scan. Defaults to document.body.
   * @returns Resolves after the first frame is ready.
   * @fires ready
   */
  mount(root?: Element): Promise<void>;

  /**
   * Deactivate planespace, restore all DOM mutations, and release GPU/event resources.
   * Safe to call when not mounted.
   */
  unmount(): void;

  // ─── Runtime Control ──────────────────────────────────────────────────────

  /**
   * Re-scan for [data-z] elements after dynamic DOM changes.
   * Call after inserting, removing, or changing depth elements.
   */
  refresh(): void;

  /**
   * Pause the render loop. No-op if already paused.
   * @fires pause
   */
  pause(): void;

  /**
   * Resume the render loop. No-op if not paused.
   * @fires resume
   */
  resume(): void;

  /**
   * Manually override the viewer position.
   * Overrides all input drivers until clearViewer() is called on InputManager.
   *
   * @param x - Normalized X offset (-1..1)
   * @param y - Normalized Y offset (-1..1)
   */
  setViewer(x: number, y: number): void;

  /**
   * Set the depth of an element programmatically.
   * Equivalent to: el.setAttribute('data-z', String(z))
   */
  setDepth(el: Element, z: number): void;

  /**
   * Update live configuration options.
   * Structural options (warpMode, depthAttr) require unmount/remount.
   */
  configure(patch: Partial<Pick<PlanespaceOptions,
    'maxAngle' | 'lerpFactor' | 'inputDeadzone' | 'debug'
  >>): void;

  // ─── Events ───────────────────────────────────────────────────────────────

  /** Fired once after the first rendered frame. */
  on(event: 'ready', handler: () => void): () => void;
  /** Fired on every rendered frame. */
  on(event: 'frame', handler: (e: FrameEvent) => void): () => void;
  /** Fired when any element's depth changes. */
  on(event: 'depthchange', handler: (e: DepthChangeEvent) => void): () => void;
  /** Fired when the render loop is paused. */
  on(event: 'pause', handler: () => void): () => void;
  /** Fired when the render loop is resumed. */
  on(event: 'resume', handler: () => void): () => void;
  /** Fired on unrecoverable runtime errors. */
  on(event: 'error', handler: (err: Error) => void): () => void;

  // ─── Utilities ────────────────────────────────────────────────────────────

  /**
   * Get a performance snapshot.
   */
  getPerformanceMetrics(): PerformanceMetrics;

  // ─── Deprecated ───────────────────────────────────────────────────────────

  /**
   * @deprecated Use refresh() instead. Will be removed in v2.0.
   */
  update(): void;
}

// ─── SpatialLayout ────────────────────────────────────────────────────────────

export interface SpatialLayoutOptions {
  /** Coordinate origin. Default: 'center' */
  origin?: 'center' | 'top-left';
  /** Scale multiplier for x/y placement. Default: 1.0 */
  scale?: number;
}

export interface PlaceOptions {
  x?: number;
  y?: number;
  z?: number;
  anchor?: 'center' | 'top-left' | 'top-right';
}

export interface TransitionOptions {
  duration?: number;
  easing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
  onComplete?: () => void;
}

export declare class SpatialLayout {
  constructor(planespace: Planespace, options?: SpatialLayoutOptions);

  /** Place an element at a 3D coordinate. */
  place(el: Element, options?: PlaceOptions): void;

  /** Define a named slot position for reuse. */
  defineSlot(name: string, position: PlaceOptions): void;

  /** Place element at a previously defined named slot. */
  placeAt(el: Element, slotName: string): void;

  /** Animate an element's Z depth value. */
  transitionZ(el: Element, targetZ: number, options?: TransitionOptions): void;

  /** Cancel all in-flight transitions and release resources. */
  destroy(): void;
}

// ─── PlanespaceCore ───────────────────────────────────────────────────────────

export interface CoreOptions {
  captureFrame?: () => Promise<{ pixels: Uint8ClampedArray; width: number; height: number }>;
  getDepthMap?: () => { data: Float32Array; width: number; height: number } | null;
  outputCallback?: (canvas: HTMLCanvasElement) => void;
  shader?: ShaderOptions;
}

export declare class PlanespaceCore {
  constructor(options: CoreOptions);
  renderFrame(viewerX: number, viewerY: number): Promise<void>;
  destroy(): void;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export declare class EventEmitter {
  on(event: string, handler: (data?: unknown) => void): () => void;
  off(event: string, handler: (data?: unknown) => void): void;
  emit(event: string, data?: unknown): void;
  removeAllListeners(event?: string): void;
  readonly listenerCount: number;
}

export declare class DepthRegistry {
  constructor(options?: {
    depthAttr?: string;
    depthRange?: [number, number];
    layers?: Record<string, number>;
    emitter?: EventEmitter;
  });
  scan(root?: Element): void;
  setDepth(el: Element, z: number): void;
  normalize(z: number): number;
  generateDepthTexture(width: number, height: number): {
    data: Float32Array;
    width: number;
    height: number;
  };
  readonly isDirty: boolean;
  readonly entries: ReadonlyArray<{ el: Element; z: number }>;
  destroy(): void;
}

export declare const VERSION: string;
