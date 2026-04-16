/**
 * DepthRegistry — scans [data-z] elements, builds depth map texture data
 */
export class DepthRegistry {
  constructor(options = {}) {
    this.depthAttr = options.depthAttr || 'data-z';
    this.depthRange = options.depthRange || [-600, 100];
    this.layers = options.layers || {};
    this.emitter = options.emitter;

    this._entries = [];
    this._depthTexture = null;
    this._dirty = false;
    this._observer = null;
  }

  /**
   * Scan a root element for all [data-z] elements and register them.
   */
  scan(root = document.body) {
    this._root = root;
    this._entries = [];

    // Collect all elements with the depth attribute
    const selector = `[${this.depthAttr}]`;
    const elements = root.querySelectorAll(selector);

    // Also include root if it has the attribute
    const allElements = root.hasAttribute && root.hasAttribute(this.depthAttr)
      ? [root, ...elements]
      : [...elements];

    for (const el of allElements) {
      const rawZ = el.getAttribute(this.depthAttr);
      const z = this._resolveZ(rawZ);
      this._entries.push({ el, z });
    }

    // Compute dynamic depth range from actual elements if not user-specified
    this._computeDepthRange();
    this._dirty = true;

    this._setupObserver(root);
  }

  /**
   * Resolve a z value: named layer or numeric string.
   */
  _resolveZ(rawZ) {
    if (this.layers[rawZ] !== undefined) {
      return this.layers[rawZ];
    }
    const n = parseFloat(rawZ);
    return isNaN(n) ? 0 : n;
  }

  /**
   * Compute the actual depth range from registered entries,
   * clamped to user-configured bounds.
   */
  _computeDepthRange() {
    if (this._entries.length === 0) {
      this._min = this.depthRange[0];
      this._max = this.depthRange[1];
      return;
    }
    this._min = this.depthRange[0];
    this._max = this.depthRange[1];
  }

  /**
   * Normalize a z value to 0..1 range for shader
   */
  normalize(z) {
    const min = this._min;
    const max = this._max;
    if (max === min) return 0.5;
    return Math.max(0, Math.min(1, (z - min) / (max - min)));
  }

  /**
   * Set depth of an element programmatically.
   */
  setDepth(el, z) {
    const old = el.getAttribute(this.depthAttr);
    const oldZ = old !== null ? this._resolveZ(old) : null;
    el.setAttribute(this.depthAttr, String(z));

    const entry = this._entries.find(e => e.el === el);
    if (entry) {
      entry.z = z;
    } else {
      this._entries.push({ el, z });
    }
    this._dirty = true;

    if (this.emitter) {
      this.emitter.emit('depthchange', { element: el, oldZ, newZ: z });
    }
  }

  /**
   * Generate a depth texture (Float32Array of normalized depth values per pixel)
   * for use by the WarpShader.
   * Returns { data: Float32Array, width, height }
   */
  generateDepthTexture(width, height) {
    const data = new Float32Array(width * height);

    // Default: fill with 0 (background)
    data.fill(0);

    for (const { el, z } of this._entries) {
      const rect = el.getBoundingClientRect();
      const scrollX = window.scrollX || 0;
      const scrollY = window.scrollY || 0;

      // Convert page rect to canvas pixel coords
      const x0 = Math.max(0, Math.floor((rect.left + scrollX) * (width / (document.documentElement.scrollWidth || window.innerWidth))));
      const y0 = Math.max(0, Math.floor((rect.top + scrollY) * (height / (document.documentElement.scrollHeight || window.innerHeight))));
      const x1 = Math.min(width, Math.ceil((rect.right + scrollX) * (width / (document.documentElement.scrollWidth || window.innerWidth))));
      const y1 = Math.min(height, Math.ceil((rect.bottom + scrollY) * (height / (document.documentElement.scrollHeight || window.innerHeight))));

      // Use viewport-relative coords for the visible frame
      const vx0 = Math.max(0, Math.floor(rect.left * width / window.innerWidth));
      const vy0 = Math.max(0, Math.floor(rect.top * height / window.innerHeight));
      const vx1 = Math.min(width, Math.ceil(rect.right * width / window.innerWidth));
      const vy1 = Math.min(height, Math.ceil(rect.bottom * height / window.innerHeight));

      const depth = this.normalize(z);

      for (let py = vy0; py < vy1; py++) {
        for (let px = vx0; px < vx1; px++) {
          const idx = py * width + px;
          // Higher depth value wins (nearer element on top)
          if (depth > data[idx]) {
            data[idx] = depth;
          }
        }
      }
    }

    this._dirty = false;
    return { data, width, height };
  }

  get isDirty() {
    return this._dirty;
  }

  get entries() {
    return this._entries;
  }

  /**
   * Watch for mutations to [data-z] elements
   */
  _setupObserver(root) {
    if (this._observer) {
      this._observer.disconnect();
    }

    this._observer = new MutationObserver((mutations) => {
      let needsRescan = false;

      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === this.depthAttr) {
          const el = mutation.target;
          const newRaw = el.getAttribute(this.depthAttr);
          const newZ = this._resolveZ(newRaw);
          const entry = this._entries.find(e => e.el === el);
          const oldZ = entry ? entry.z : null;

          if (entry) {
            entry.z = newZ;
          } else {
            this._entries.push({ el, z: newZ });
          }

          this._dirty = true;
          if (this.emitter) {
            this.emitter.emit('depthchange', { element: el, oldZ, newZ });
          }
        } else if (mutation.type === 'childList') {
          needsRescan = true;
        }
      }

      if (needsRescan) {
        this.scan(root);
      }
    });

    this._observer.observe(root, {
      attributes: true,
      attributeFilter: [this.depthAttr],
      subtree: true,
      childList: true,
    });
  }

  destroy() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    this._entries = [];
  }
}
