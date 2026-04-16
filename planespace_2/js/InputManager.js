import { MouseInput } from './MouseInput.js';
import { GyroInput } from './GyroInput.js';

/**
 * InputManager — selects the right input strategy and smooths the viewer angle
 */
export class InputManager {
  constructor(options = {}) {
    this.inputMode = options.inputMode || 'mouse';
    this.lerpFactor = options.lerpFactor !== undefined ? options.lerpFactor : 0.06;
    this.options = options;

    this._viewerX = 0;
    this._viewerY = 0;
    this._externalX = 0;
    this._externalY = 0;
    this._externalOverride = false;

    this._drivers = [];
    this._setupDrivers();
  }

  _isMobile() {
    return typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  }

  _setupDrivers() {
    const mode = this.inputMode;
    const isMobile = this._isMobile();

    if (mode === 'mouse' || (mode === 'both' && !isMobile)) {
      this._drivers.push(new MouseInput(this.options));
    }

    if (mode === 'gyro' || (mode === 'both' && isMobile)) {
      this._drivers.push(new GyroInput(this.options));
    }
    // 'none' mode: no drivers added
  }

  attach() {
    for (const d of this._drivers) d.attach();
  }

  detach() {
    for (const d of this._drivers) d.detach();
  }

  /**
   * Manually set viewer position (external/programmatic mode).
   * When called, overrides driver input.
   */
  setViewer(x, y) {
    this._externalX = Math.max(-1, Math.min(1, x));
    this._externalY = Math.max(-1, Math.min(1, y));
    this._externalOverride = true;
  }

  /**
   * Tick: lerp toward target. Call once per frame.
   * Returns current smoothed { x, y }.
   */
  tick() {
    let targetX, targetY;

    if (this._externalOverride) {
      targetX = this._externalX;
      targetY = this._externalY;
    } else if (this._drivers.length > 0) {
      // Average all drivers (handles 'both' mode)
      let sumX = 0, sumY = 0;
      for (const d of this._drivers) {
        const t = d.getTarget();
        sumX += t.x;
        sumY += t.y;
      }
      targetX = sumX / this._drivers.length;
      targetY = sumY / this._drivers.length;
    } else {
      targetX = 0;
      targetY = 0;
    }

    // Lerp toward target (lerpFactor 0=instant, close to 1=very slow)
    const alpha = 1 - Math.pow(1 - this.lerpFactor, 1); // per-frame lerp
    this._viewerX += (targetX - this._viewerX) * (1 - (1 - this.lerpFactor) * 10 > 1 ? 1 : this.lerpFactor * 10);
    this._viewerY += (targetY - this._viewerY) * (1 - (1 - this.lerpFactor) * 10 > 1 ? 1 : this.lerpFactor * 10);

    return { x: this._viewerX, y: this._viewerY };
  }

  get current() {
    return { x: this._viewerX, y: this._viewerY };
  }
}
