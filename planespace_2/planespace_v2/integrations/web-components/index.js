/**
 * planespace/web-components — Custom Elements integration.
 *
 * Provides <planespace-scene> for framework-agnostic use.
 *
 * @example HTML usage:
 *   <script type="module" src="planespace-element.js"></script>
 *   <planespace-scene max-angle="8" input-mode="mouse">
 *     <h1 data-z="60">Title</h1>
 *     <div data-z="-200">Background</div>
 *   </planespace-scene>
 *
 * @example JS usage:
 *   import { PlanespaceElement } from 'planespace/web-components';
 *   customElements.define('planespace-scene', PlanespaceElement);
 *
 *   const scene = document.querySelector('planespace-scene');
 *   scene.addEventListener('ps-ready', () => console.log('active'));
 */
import { Planespace } from '../src/index.js';

/**
 * <planespace-scene> — Custom Element.
 *
 * Observed attributes map to PlanespaceOptions:
 *   max-angle         → maxAngle
 *   lerp-factor       → lerpFactor
 *   input-mode        → inputMode
 *   warp-mode         → warpMode
 *   depth-attr        → depthAttr
 *   perspective       → perspective
 *   debug             → debug
 *
 * Events:
 *   ps-ready          → fires when first frame renders
 *   ps-frame          → fires each frame (detail: { rx, ry, frameCount })
 *   ps-depthchange    → fires when any element's depth changes
 */
export class PlanespaceElement extends HTMLElement {
  static get observedAttributes() {
    return [
      'max-angle',
      'lerp-factor',
      'input-mode',
      'warp-mode',
      'depth-attr',
      'perspective',
      'debug',
    ];
  }

  #ps = null;
  #unsubscribers = [];

  connectedCallback() {
    // Defer to next microtask so children are parsed
    Promise.resolve().then(() => this.#mount());
  }

  disconnectedCallback() {
    this.#unmount();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    // Structural changes require remount
    const structural = ['input-mode', 'warp-mode', 'depth-attr'];
    if (structural.includes(name) && this.#ps?.mounted) {
      this.#unmount();
      this.#mount();
    } else if (this.#ps?.mounted) {
      // Live-update non-structural options
      const patch = this.#attrToPatch(name, newValue);
      if (patch) this.#ps.configure(patch);
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /** Planespace instance. Available after 'ps-ready'. */
  get planespace() { return this.#ps; }

  /** Whether planespace is mounted. */
  get active() { return this.#ps?.mounted ?? false; }

  /** Current viewer position. */
  get viewer() { return this.#ps?.viewer ?? { x: 0, y: 0 }; }

  /** Set viewer position programmatically. */
  setViewer(x, y) { this.#ps?.setViewer(x, y); }

  /** Pause rendering. */
  pause() { this.#ps?.pause(); }

  /** Resume rendering. */
  resume() { this.#ps?.resume(); }

  // ─── Private ─────────────────────────────────────────────────────────────

  async #mount() {
    this.#unmount();

    const opts = this.#buildOptions();
    this.#ps = new Planespace(opts);

    this.#unsubscribers.push(
      this.#ps.on('ready', () => {
        this.setAttribute('data-ps-state', 'active');
        this.dispatchEvent(new CustomEvent('ps-ready', { bubbles: true }));
      }),
      this.#ps.on('frame', (e) => {
        this.dispatchEvent(new CustomEvent('ps-frame', { detail: e, bubbles: false }));
      }),
      this.#ps.on('depthchange', (e) => {
        this.dispatchEvent(new CustomEvent('ps-depthchange', { detail: e, bubbles: true }));
      }),
    );

    await this.#ps.mount(this);
  }

  #unmount() {
    if (!this.#ps) return;
    for (const off of this.#unsubscribers) off();
    this.#unsubscribers = [];
    this.#ps.unmount();
    this.#ps = null;
    this.removeAttribute('data-ps-state');
  }

  #buildOptions() {
    return {
      maxAngle: this.#numAttr('max-angle', 6),
      lerpFactor: this.#numAttr('lerp-factor', 0.06),
      inputMode: this.getAttribute('input-mode') || 'mouse',
      warpMode: this.getAttribute('warp-mode') || 'reproject',
      depthAttr: this.getAttribute('depth-attr') || 'data-z',
      perspective: this.#numAttr('perspective', 900),
      debug: this.hasAttribute('debug'),
    };
  }

  #numAttr(name, fallback) {
    const v = parseFloat(this.getAttribute(name));
    return isNaN(v) ? fallback : v;
  }

  #attrToPatch(name, value) {
    switch (name) {
      case 'max-angle':   return { maxAngle: parseFloat(value) };
      case 'lerp-factor': return { lerpFactor: parseFloat(value) };
      case 'debug':       return { debug: value !== null };
      default:            return null;
    }
  }
}

/**
 * Register <planespace-scene> as a Custom Element.
 * Call once in your app entry point.
 */
export function register(tagName = 'planespace-scene') {
  if (!customElements.get(tagName)) {
    customElements.define(tagName, PlanespaceElement);
  }
}

// Auto-register if this module is loaded as a script
if (document.currentScript) {
  register();
}
