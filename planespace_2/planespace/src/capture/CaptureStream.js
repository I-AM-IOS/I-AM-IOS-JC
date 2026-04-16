/**
 * CaptureStream — uses HTMLCanvasElement.captureStream() to grab page frames
 * Available Chrome 94+, Firefox 105+
 */
export class CaptureStream {
  constructor(options = {}) {
    this.resolution = options.captureResolution || 1.0;
    this._video = null;
    this._stream = null;
    this._canvas = null;
    this._ctx = null;
    this._ready = false;
  }

  async init(targetWidth, targetHeight) {
    // We use html2canvas or a visible canvas to create a capturable surface
    // The actual capture happens via offscreen canvas + drawImage from video
    // For the capture stream approach, we need a MediaStream from the document

    // Create an offscreen canvas that matches viewport
    this._canvas = new OffscreenCanvas(
      Math.round(targetWidth * this.resolution),
      Math.round(targetHeight * this.resolution)
    );
    this._ctx = this._canvas.getContext('2d');
    this._ready = true;
  }

  /**
   * Capture current page frame.
   * Returns ImageBitmap or null.
   */
  async capture(sourceCanvas) {
    if (!this._ready || !sourceCanvas) return null;

    const w = this._canvas.width;
    const h = this._canvas.height;
    this._ctx.drawImage(sourceCanvas, 0, 0, w, h);

    return await createImageBitmap(this._canvas);
  }

  destroy() {
    this._ready = false;
    this._canvas = null;
    this._ctx = null;
  }

  static isSupported() {
    return typeof OffscreenCanvas !== 'undefined';
  }
}
