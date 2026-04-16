import { DepthRegistry } from './DepthRegistry.js';
import { WarpShader } from '../shader/WarpShader.js';

/**
 * PlanespaceCore — low-level render interface for custom runtimes
 * (Servo, Ladybird, embedded WebView, etc.)
 *
 * You provide the frame capture and output callback;
 * PlanespaceCore handles the depth warp.
 */
export class PlanespaceCore {
  constructor(options = {}) {
    this.captureFrame = options.captureFrame;
    this.getDepthMap = options.getDepthMap;
    this.outputCallback = options.outputCallback;

    this._canvas = document.createElement('canvas');
    this._canvas.width = window.innerWidth;
    this._canvas.height = window.innerHeight;

    this._shader = new WarpShader(this._canvas, options);
    this._shader.init();

    if (this.outputCallback) {
      this.outputCallback(this._canvas);
    }
  }

  /**
   * Render one frame with the given viewer angle.
   */
  async renderFrame(viewerX, viewerY) {
    if (this.captureFrame) {
      const frame = await this.captureFrame();
      if (frame) {
        // Convert Uint8ClampedArray to ImageData then upload
        const imageData = new ImageData(frame.pixels, frame.width, frame.height);
        const bmp = await createImageBitmap(imageData);
        this._shader.uploadScene(bmp);
      }
    }

    if (this.getDepthMap) {
      const depthMap = this.getDepthMap();
      if (depthMap) {
        this._shader.uploadDepth(depthMap);
      }
    }

    this._shader.render(viewerX, viewerY);
  }

  destroy() {
    this._shader.destroy();
  }
}
