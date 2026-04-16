/**
 * SpatialLayout — optional 3D coordinate system for placing elements in Z-space.
 *
 * Works on top of the public Planespace API — never accesses private internals.
 *
 * @example
 *   const layout = new SpatialLayout(ps, { origin: 'center', scale: 1.5 });
 *   layout.place(titleEl, { x: 0, y: -120, z: 80 });
 *   layout.defineSlot('hero', { x: 0, y: 0, z: 0 });
 *   layout.placeAt(cardEl, 'hero');
 */
export class SpatialLayout {
  constructor(planespace, options = {}) {
    // Accept the public Planespace instance — no internal access
    this._ps = planespace;
    this.origin = options.origin || 'center';
    this.scale = options.scale || 1.0;
    this._slots = new Map();
    this._transitions = new Set();
  }

  /**
   * Place an element at a 3D position.
   *
   * @param {Element} el
   * @param {{ x?: number, y?: number, z?: number, anchor?: string }} options
   */
  place(el, { x = 0, y = 0, z = 0, anchor = 'center' } = {}) {
    const scaledX = x * this.scale;
    const scaledY = y * this.scale;

    let originX = 0, originY = 0;
    if (this.origin === 'center') {
      originX = window.innerWidth / 2;
      originY = window.innerHeight / 2;
    }

    if (el.style) {
      el.style.position = 'absolute';

      let left = originX + scaledX;
      let top = originY + scaledY;

      if (anchor === 'center') {
        const rect = el.getBoundingClientRect();
        left -= rect.width / 2;
        top -= rect.height / 2;
      }

      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
    }

    // Use the public API — never access _depthRegistry or any internal
    if (this._ps && typeof this._ps.setDepth === 'function') {
      this._ps.setDepth(el, z);
    } else {
      el.setAttribute('data-z', String(z));
    }
  }

  /**
   * Define a named slot for reuse across multiple elements.
   *
   * @param {string} name
   * @param {{ x?: number, y?: number, z?: number, anchor?: string }} position
   */
  defineSlot(name, position) {
    this._slots.set(name, position);
  }

  /**
   * Place element at a previously defined named slot.
   *
   * @param {Element} el
   * @param {string} slotName
   */
  placeAt(el, slotName) {
    const slot = this._slots.get(slotName);
    if (!slot) {
      console.warn(`[planespace/SpatialLayout] Unknown slot: "${slotName}". ` +
        `Define it first with defineSlot("${slotName}", { ... }).`);
      return;
    }
    this.place(el, slot);
  }

  /**
   * Animate an element's Z value over time.
   *
   * @param {Element} el
   * @param {number} targetZ
   * @param {{ duration?: number, easing?: string, onComplete?: Function }} options
   */
  transitionZ(el, targetZ, { duration = 400, easing = 'ease-out', onComplete } = {}) {
    const setDepth = (z) => {
      if (this._ps && typeof this._ps.setDepth === 'function') {
        this._ps.setDepth(el, z);
      } else {
        el.setAttribute('data-z', String(z));
      }
    };

    const startZ = parseFloat(el.getAttribute('data-z') || '0');
    const startTime = performance.now();
    const easeFn = EASING[easing] || EASING['ease-out'];

    const tick = (now) => {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      const eased = easeFn(t);
      const currentZ = startZ + (targetZ - startZ) * eased;
      setDepth(currentZ);

      if (t < 1) {
        const id = requestAnimationFrame(tick);
        this._transitions.add(id);
      } else {
        setDepth(targetZ);
        onComplete?.();
      }
    };

    const id = requestAnimationFrame(tick);
    this._transitions.add(id);
  }

  /** Cancel all in-flight Z transitions. */
  destroy() {
    for (const id of this._transitions) cancelAnimationFrame(id);
    this._transitions.clear();
  }
}

const EASING = {
  'linear':      t => t,
  'ease-in':     t => t * t,
  'ease-out':    t => t * (2 - t),
  'ease-in-out': t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
};
