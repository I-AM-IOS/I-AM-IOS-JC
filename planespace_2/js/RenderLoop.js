/**
 * RenderLoop — requestAnimationFrame-based render loop with frame scheduling
 */
export class RenderLoop {
  constructor(options = {}) {
    this.targetFPS = options.targetFPS || 60;
    this._onFrame = options.onFrame || (() => {});
    this._rafId = null;
    this._running = false;
    this._lastTime = 0;
    this._frameInterval = 1000 / this.targetFPS;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._lastTime = 0;
    this._schedule();
  }

  stop() {
    this._running = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  _schedule() {
    this._rafId = requestAnimationFrame((timestamp) => {
      if (!this._running) return;

      const elapsed = timestamp - this._lastTime;

      if (elapsed >= this._frameInterval) {
        this._lastTime = timestamp - (elapsed % this._frameInterval);
        this._onFrame(timestamp);
      }

      this._schedule();
    });
  }

  setTargetFPS(fps) {
    this.targetFPS = fps;
    this._frameInterval = 1000 / fps;
  }
}
