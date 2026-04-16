/**
 * Html2canvas — fallback capture strategy using html2canvas library
 * Used when captureStream is not available.
 */
export class Html2canvasCapture {
  constructor(options = {}) {
    this.resolution = options.captureResolution || 1.0;
    this._h2c = null;
    this._canvas = null;
  }

  async init() {
    // Attempt to load html2canvas dynamically if not available
    if (typeof html2canvas === 'undefined') {
      if (typeof window !== 'undefined' && window.html2canvas) {
        this._h2c = window.html2canvas;
      } else {
        // Try dynamic import as last resort
        try {
          const mod = await import('html2canvas');
          this._h2c = mod.default || mod;
        } catch {
          throw new Error('[planespace] html2canvas not available');
        }
      }
    } else {
      this._h2c = html2canvas;
    }
  }

  /**
   * Capture the given root element.
   * Returns ImageBitmap.
   */
  async capture(root = document.body) {
    if (!this._h2c) return null;

    const scale = this.resolution;
    const canvas = await this._h2c(root, {
      scale,
      useCORS: true,
      allowTaint: false,
      logging: false,
      backgroundColor: null,
    });

    return await createImageBitmap(canvas);
  }

  destroy() {
    this._h2c = null;
  }
}
