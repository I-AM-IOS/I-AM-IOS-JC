/**
 * SpatialLayout — optional coordinate system for placing elements in Z-space
 */
export class SpatialLayout {
  constructor(planespace, options = {}) {
    this._ps = planespace;
    this.origin = options.origin || 'center';
    this.scale = options.scale || 1.0;
    this._slots = new Map();
    this._transitions = new Set();
  }

  /**
   * Place an element at a 3D position.
   */
  place(el, { x = 0, y = 0, z = 0, anchor = 'center' } = {}) {
    const scaledX = x * this.scale;
    const scaledY = y * this.scale;
    const scaledZ = z;

    // Apply CSS positioning
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

    // Set depth
    if (this._ps && this._ps._depthRegistry) {
      this._ps._depthRegistry.setDepth(el, scaledZ);
    } else {
      el.setAttribute('data-z', String(scaledZ));
    }
  }

  /**
   * Define a named slot for reuse.
   */
  defineSlot(name, position) {
    this._slots.set(name, position);
  }

  /**
   * Place element at a named slot.
   */
  placeAt(el, slotName) {
    const slot = this._slots.get(slotName);
    if (!slot) {
      console.warn(`[planespace] Unknown slot: "${slotName}"`);
      return;
    }
    this.place(el, slot);
  }

  /**
   * Animate an element's Z value over time.
   */
  transitionZ(el, targetZ, { duration = 400, easing = 'ease-out', onComplete } = {}) {
    const registry = this._ps && this._ps._depthRegistry;
    if (!registry) {
      el.setAttribute('data-z', String(targetZ));
      onComplete && onComplete();
      return;
    }

    const startZ = parseFloat(el.getAttribute('data-z') || '0');
    const startTime = performance.now();

    const easeFn = EASING[easing] || EASING['ease-out'];

    const tick = (now) => {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      const eased = easeFn(t);
      const currentZ = startZ + (targetZ - startZ) * eased;

      registry.setDepth(el, currentZ);

      if (t < 1) {
        const id = requestAnimationFrame(tick);
        this._transitions.add(id);
      } else {
        registry.setDepth(el, targetZ);
        onComplete && onComplete();
      }
    };

    const id = requestAnimationFrame(tick);
    this._transitions.add(id);
  }

  destroy() {
    for (const id of this._transitions) {
      cancelAnimationFrame(id);
    }
    this._transitions.clear();
  }
}

const EASING = {
  'linear': t => t,
  'ease-in': t => t * t,
  'ease-out': t => t * (2 - t),
  'ease-in-out': t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
};
