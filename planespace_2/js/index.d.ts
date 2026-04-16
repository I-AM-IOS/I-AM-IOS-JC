// planespace TypeScript definitions

export interface ShaderOptions {
  warpStrength?: number;
  edgeClamping?: boolean;
  chromaticOffset?: boolean;
  chromaticStrength?: number;
  vignetteStrength?: number;
  temporalSmoothing?: number;
  fragment?: string | null;
}

export interface CompositorOptions {
  targetFPS?: number;
  captureResolution?: number;
  skipIfDOMDirty?: boolean;
  strategy?: 'auto' | 'captureStream' | 'html2canvas' | 'transform';
}

export interface GyroOptions {
  sensitivity?: number;
  axes?: 'beta-gamma' | 'alpha-beta';
  calibrateOnMount?: boolean;
}

export interface PlanespaceOptions {
  /** Input mode: 'mouse' | 'gyro' | 'both' | 'none'. Default: 'mouse' */
  inputMode?: 'mouse' | 'gyro' | 'both' | 'none';
  /** Maximum scene rotation in degrees. Default: 6 */
  maxAngle?: number;
  /** Camera smoothing factor. 0=instant. Default: 0.06 */
  lerpFactor?: number;
  /** Deadzone radius at center (normalized). Default: 0.03 */
  inputDeadzone?: number;
  /** HTML attribute name for depth values. Default: 'data-z' */
  depthAttr?: string;
  /** [min, max] z value range. Default: [-600, 100] */
  depthRange?: [number, number];
  /** Named z-layers map */
  layers?: Record<string, number>;
  /** Warp mode. Default: 'reproject' */
  warpMode?: 'reproject' | 'transform' | 'hybrid';
  /** Shader options (reproject mode) */
  shader?: ShaderOptions;
  /** Compositor options */
  compositor?: CompositorOptions;
  /** CSS perspective value in px. Default: 900 */
  perspective?: number;
  /** Provide your own output canvas element */
  outputCanvas?: HTMLCanvasElement | null;
  /** z-index of the output canvas overlay. Default: 2147483647 */
  outputZIndex?: number;
  /** Gyroscope input options */
  gyro?: GyroOptions;
  /** Show debug overlay. Default: false */
  debug?: boolean;
}

export interface FrameEvent {
  rx: number;
  ry: number;
  timestamp: number;
}

export interface DepthChangeEvent {
  element: Element;
  oldZ: number | null;
  newZ: number;
}

export type PlanespaceEvent = 'ready' | 'frame' | 'depthchange' | 'pause' | 'resume' | 'error';

export class Planespace {
  constructor(options?: PlanespaceOptions);
  mount(root?: Element): Promise<void>;
  unmount(): void;
  update(): void;
  setViewer(x: number, y: number): void;
  pause(): void;
  resume(): void;
  on(event: 'ready', handler: () => void): () => void;
  on(event: 'frame', handler: (e: FrameEvent) => void): () => void;
  on(event: 'depthchange', handler: (e: DepthChangeEvent) => void): () => void;
  on(event: 'pause' | 'resume', handler: () => void): () => void;
  on(event: 'error', handler: (err: Error) => void): () => void;
  setDepth(el: Element, z: number): void;
}

export interface SpatialLayoutOptions {
  origin?: 'center' | 'top-left';
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

export class SpatialLayout {
  constructor(planespace: Planespace, options?: SpatialLayoutOptions);
  place(el: Element, options?: PlaceOptions): void;
  defineSlot(name: string, position: PlaceOptions): void;
  placeAt(el: Element, slotName: string): void;
  transitionZ(el: Element, targetZ: number, options?: TransitionOptions): void;
  destroy(): void;
}

export interface CoreOptions {
  captureFrame?: () => Promise<{ pixels: Uint8ClampedArray; width: number; height: number }>;
  getDepthMap?: () => { data: Float32Array; width: number; height: number } | null;
  outputCallback?: (canvas: HTMLCanvasElement) => void;
  shader?: ShaderOptions;
}

export class PlanespaceCore {
  constructor(options: CoreOptions);
  renderFrame(viewerX: number, viewerY: number): Promise<void>;
  destroy(): void;
}

export class EventEmitter {
  on(event: string, handler: (data?: any) => void): () => void;
  off(event: string, handler: (data?: any) => void): void;
  emit(event: string, data?: any): void;
  removeAllListeners(event?: string): void;
}

export class DepthRegistry {
  constructor(options?: {
    depthAttr?: string;
    depthRange?: [number, number];
    layers?: Record<string, number>;
    emitter?: EventEmitter;
  });
  scan(root?: Element): void;
  setDepth(el: Element, z: number): void;
  normalize(z: number): number;
  generateDepthTexture(width: number, height: number): { data: Float32Array; width: number; height: number };
  readonly isDirty: boolean;
  readonly entries: Array<{ el: Element; z: number }>;
  destroy(): void;
}
