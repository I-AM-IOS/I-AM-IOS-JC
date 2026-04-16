/**
 * GyroInput — DeviceOrientationEvent → normalized viewer angle
 */
export class GyroInput {
  constructor(options = {}) {
    this.sensitivity = (options.gyro && options.gyro.sensitivity) || 0.8;
    this.axes = (options.gyro && options.gyro.axes) || 'beta-gamma';
    this.calibrateOnMount = (options.gyro && options.gyro.calibrateOnMount !== false);
    this.maxAngle = options.maxAngle || 6;

    this._targetX = 0;
    this._targetY = 0;
    this._baseAlpha = null;
    this._baseBeta = null;
    this._baseGamma = null;
    this._permissionGranted = false;
    this._handler = this._onOrientation.bind(this);
    this._interactionHandler = this._requestPermission.bind(this);
  }

  attach() {
    if (typeof DeviceOrientationEvent === 'undefined') {
      console.warn('[planespace] DeviceOrientationEvent not supported');
      return;
    }

    // iOS 13+ requires permission
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      // Ask on first user interaction
      window.addEventListener('click', this._interactionHandler, { once: true });
      window.addEventListener('touchstart', this._interactionHandler, { once: true });
    } else {
      this._startListening();
    }
  }

  async _requestPermission() {
    try {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result === 'granted') {
        this._startListening();
      }
    } catch (err) {
      console.warn('[planespace] Gyro permission denied:', err);
    }
  }

  _startListening() {
    this._permissionGranted = true;
    window.addEventListener('deviceorientation', this._handler, { passive: true });
  }

  detach() {
    window.removeEventListener('deviceorientation', this._handler);
    window.removeEventListener('click', this._interactionHandler);
    window.removeEventListener('touchstart', this._interactionHandler);
  }

  _onOrientation(e) {
    const { beta, gamma } = e;

    if (this.calibrateOnMount && this._baseBeta === null) {
      this._baseBeta = beta;
      this._baseGamma = gamma;
    }

    let relBeta = beta - (this._baseBeta || 0);
    let relGamma = gamma - (this._baseGamma || 0);

    // Normalize to -1..1 using maxAngle as the reference range
    let nx = (relGamma / this.maxAngle) * this.sensitivity;
    let ny = (relBeta / this.maxAngle) * this.sensitivity;

    // Clamp
    nx = Math.max(-1, Math.min(1, nx));
    ny = Math.max(-1, Math.min(1, ny));

    this._targetX = nx;
    this._targetY = ny;
  }

  getTarget() {
    return { x: this._targetX, y: this._targetY };
  }

  calibrate() {
    this._baseBeta = null;
    this._baseGamma = null;
  }
}
