/**
 * PlanespaceGame — a lightweight narrative game framework.
 *
 * Treats a game as a sequence of layered HTML "scenes" — like pages in a
 * popup book. Each scene is a set of depth layers (CSS art) + interactive
 * objects. Planespace makes them feel spatial. You just write the pages.
 *
 * @example
 *   const game = new PlanespaceGame({ container: document.body, maxAngle: 5 });
 *
 *   game.scene('forest', {
 *     layers: [
 *       { z: -400, style: 'background: #0a1a0a', html: '<div class="stars"></div>' },
 *       { z: -200, html: '<div class="trees-far"></div>' },
 *       { z:    0, html: '<div class="ground"></div>' },
 *     ],
 *     objects: [
 *       { id: 'chest', z: 40, x: '60%', y: '68%', html: '<div class="chest">📦</div>', action: 'openChest' },
 *     ],
 *     onEnter: (state, { say }) => say([{ text: 'The forest is quiet.' }]),
 *   });
 *
 *   game.action('openChest', (state, { say, go }) => {
 *     state.set('hasKey', true);
 *     say([{ speaker: 'You', text: 'A key. This must open the gate.' }])
 *       .then(() => go('gate'));
 *   });
 *
 *   game.start('forest');
 */

// ─── Minimal built-in parallax (no external dependency required) ──────────────

class _ParallaxEngine {
  constructor(root, options = {}) {
    this._root = root;
    this._maxAngle = options.maxAngle || 5;
    this._lerp = options.lerpFactor || 0.06;
    this._perspective = options.perspective || 1100;
    this._rx = 0;
    this._ry = 0;
    this._tx = 0;
    this._ty = 0;
    this._raf = null;
    this._onMove = this._onMove.bind(this);
  }

  mount() {
    this._root.style.perspective = `${this._perspective}px`;
    this._root.style.transformStyle = 'preserve-3d';
    this._applyDepths();
    window.addEventListener('mousemove', this._onMove, { passive: true });
    this._tick();
  }

  refresh() {
    this._applyDepths();
  }

  _applyDepths() {
    const els = this._root.querySelectorAll('[data-z]');
    for (const el of els) {
      const z = parseFloat(el.getAttribute('data-z') || 0);
      el.style.transform = `translateZ(${z}px)`;
      el.style.transformStyle = 'preserve-3d';
    }
  }

  _onMove(e) {
    this._tx = ((e.clientX / window.innerWidth)  * 2 - 1);
    this._ty = ((e.clientY / window.innerHeight) * 2 - 1);
  }

  _tick() {
    this._rx += (this._tx - this._rx) * this._lerp;
    this._ry += (this._ty - this._ry) * this._lerp;
    const rotY =  this._rx * this._maxAngle;
    const rotX = -this._ry * this._maxAngle;
    this._root.style.transform =
      `perspective(${this._perspective}px) rotateY(${rotY}deg) rotateX(${rotX}deg)`;
    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  destroy() {
    window.removeEventListener('mousemove', this._onMove);
    cancelAnimationFrame(this._raf);
    this._root.style.transform = '';
    this._root.style.perspective = '';
  }
}

// ─── GameState ────────────────────────────────────────────────────────────────

class GameState {
  #data = {};

  get(key)        { return this.#data[key]; }
  set(key, value) { this.#data[key] = value; return this; }
  has(key)        { return key in this.#data; }
  toggle(key)     { this.#data[key] = !this.#data[key]; return this; }
  increment(key, by = 1) { this.#data[key] = (this.#data[key] || 0) + by; return this; }
  all()           { return { ...this.#data }; }
}

// ─── DialogueEngine ───────────────────────────────────────────────────────────

class DialogueEngine {
  #box;
  #nameEl;
  #textEl;
  #promptEl;
  #choiceEl;
  #visible = false;

  constructor(container, theme = {}) {
    this.#build(container, theme);
  }

  #build(container, theme) {
    const box = document.createElement('div');
    box.id = 'psg-dialogue';
    box.style.cssText = `
      position: fixed;
      bottom: 0; left: 0; right: 0;
      padding: 0 5% 32px;
      z-index: 1000;
      pointer-events: none;
      opacity: 0;
      transform: translateY(12px);
      transition: opacity 0.25s ease, transform 0.25s ease;
      font-family: ${theme.fontFamily || '"Crimson Text", Georgia, serif'};
    `;

    const inner = document.createElement('div');
    inner.style.cssText = `
      background: ${theme.bg || 'rgba(8,6,14,0.92)'};
      border: 1px solid ${theme.border || 'rgba(255,255,255,0.12)'};
      border-radius: 10px;
      padding: 20px 28px 22px;
      backdrop-filter: blur(14px);
      max-width: 820px;
      margin: 0 auto;
      pointer-events: all;
      cursor: pointer;
      box-shadow: 0 -8px 48px rgba(0,0,0,0.5);
    `;

    this.#nameEl = document.createElement('div');
    this.#nameEl.style.cssText = `
      font-size: 0.78rem;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: ${theme.nameColor || '#c9a84c'};
      margin-bottom: 8px;
      font-family: ${theme.monoFont || '"JetBrains Mono", monospace'};
      min-height: 1.1em;
    `;

    this.#textEl = document.createElement('div');
    this.#textEl.style.cssText = `
      font-size: ${theme.fontSize || '1.12rem'};
      line-height: 1.65;
      color: ${theme.textColor || '#e8e2d4'};
    `;

    this.#promptEl = document.createElement('div');
    this.#promptEl.style.cssText = `
      font-size: 0.68rem;
      color: rgba(200,190,160,0.4);
      text-align: right;
      margin-top: 10px;
      font-family: ${theme.monoFont || '"JetBrains Mono", monospace'};
      letter-spacing: 0.12em;
      animation: psg-blink 1.4s ease-in-out infinite;
    `;
    this.#promptEl.textContent = '▸ click to continue';

    this.#choiceEl = document.createElement('div');
    this.#choiceEl.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 14px;
    `;

    inner.append(this.#nameEl, this.#textEl, this.#choiceEl, this.#promptEl);
    box.appendChild(inner);
    container.appendChild(box);
    this.#box = box;

    // Blink animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes psg-blink {
        0%, 100% { opacity: 0.4; }
        50% { opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Show a sequence of dialogue lines.
   * Each line: { speaker?: string, text: string }
   * @returns {Promise<void>} resolves when all lines are dismissed
   */
  say(lines) {
    return new Promise(resolve => {
      const queue = Array.isArray(lines) ? [...lines] : [{ text: lines }];

      const showNext = () => {
        if (queue.length === 0) {
          this.hide();
          resolve();
          return;
        }
        const line = queue.shift();
        this.#nameEl.textContent = line.speaker || '';
        this.#textEl.textContent = line.text;
        this.#choiceEl.innerHTML = '';
        this.#promptEl.style.display = '';
        this.show();

        // Click anywhere on box to advance
        const advance = () => {
          this.#box.querySelector('div').removeEventListener('click', advance);
          showNext();
        };
        this.#box.querySelector('div').addEventListener('click', advance, { once: true });
      };

      showNext();
    });
  }

  /**
   * Show a multiple-choice prompt.
   * choices: [{ text: string, value: any }]
   * @returns {Promise<any>} resolves with the chosen value
   */
  choice(prompt, choices, theme = {}) {
    return new Promise(resolve => {
      this.#nameEl.textContent = '';
      this.#textEl.textContent = prompt;
      this.#promptEl.style.display = 'none';
      this.#choiceEl.innerHTML = '';

      for (const opt of choices) {
        const btn = document.createElement('button');
        btn.textContent = opt.text;
        btn.style.cssText = `
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 6px;
          color: #e8e2d4;
          font-family: inherit;
          font-size: 0.95rem;
          padding: 10px 16px;
          text-align: left;
          cursor: pointer;
          transition: background 0.12s, border-color 0.12s;
        `;
        btn.addEventListener('mouseenter', () => {
          btn.style.background = 'rgba(255,255,255,0.12)';
          btn.style.borderColor = 'rgba(255,255,255,0.28)';
        });
        btn.addEventListener('mouseleave', () => {
          btn.style.background = 'rgba(255,255,255,0.06)';
          btn.style.borderColor = 'rgba(255,255,255,0.12)';
        });
        btn.addEventListener('click', () => {
          this.hide();
          resolve(opt.value ?? opt.text);
        });
        this.#choiceEl.appendChild(btn);
      }

      this.show();
    });
  }

  show() {
    if (this.#visible) return;
    this.#visible = true;
    this.#box.style.opacity = '1';
    this.#box.style.transform = 'translateY(0)';
    this.#box.style.pointerEvents = 'all';
  }

  hide() {
    if (!this.#visible) return;
    this.#visible = false;
    this.#box.style.opacity = '0';
    this.#box.style.transform = 'translateY(12px)';
    this.#box.style.pointerEvents = 'none';
  }

  get isVisible() { return this.#visible; }
}

// ─── TransitionEngine ─────────────────────────────────────────────────────────

class TransitionEngine {
  #overlay;

  constructor(container) {
    this.#overlay = document.createElement('div');
    this.#overlay.style.cssText = `
      position: fixed; inset: 0;
      background: #000;
      z-index: 999;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.4s ease;
    `;
    container.appendChild(this.#overlay);
  }

  async fadeOut() {
    this.#overlay.style.transition = 'opacity 0.4s ease';
    this.#overlay.style.opacity = '1';
    await new Promise(r => setTimeout(r, 420));
  }

  async fadeIn() {
    this.#overlay.style.transition = 'opacity 0.5s ease';
    this.#overlay.style.opacity = '0';
    await new Promise(r => setTimeout(r, 520));
  }

  async flash(color = '#ffffff', duration = 120) {
    this.#overlay.style.background = color;
    this.#overlay.style.transition = `opacity ${duration}ms ease`;
    this.#overlay.style.opacity = '0.8';
    await new Promise(r => setTimeout(r, duration));
    this.#overlay.style.transition = 'opacity 0.4s ease';
    this.#overlay.style.opacity = '0';
    await new Promise(r => setTimeout(r, 420));
    this.#overlay.style.background = '#000';
  }
}

// ─── PlanespaceGame ───────────────────────────────────────────────────────────

export class PlanespaceGame {
  #scenes   = new Map();
  #actions  = new Map();
  #state    = new GameState();
  #engine   = null;
  #dialogue = null;
  #transition = null;
  #container  = null;
  #sceneEl    = null;
  #currentScene = null;
  #options  = {};
  #cursor   = null;

  constructor(options = {}) {
    this.#options = options;
    this.#container = options.container || document.body;

    // Fullscreen container
    this.#container.style.cssText += `
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #000;
    `;

    // Scene layer
    this.#sceneEl = document.createElement('div');
    this.#sceneEl.id = 'psg-scene';
    this.#sceneEl.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
    this.#container.appendChild(this.#sceneEl);

    // Parallax engine
    this.#engine = new _ParallaxEngine(this.#sceneEl, {
      maxAngle:    options.maxAngle    || 5,
      lerpFactor:  options.lerpFactor  || 0.055,
      perspective: options.perspective || 1100,
    });

    // Dialogue engine
    this.#dialogue = new DialogueEngine(this.#container, options.theme || {});

    // Transition engine
    this.#transition = new TransitionEngine(this.#container);

    // Custom cursor
    if (options.cursor !== false) {
      this.#setupCursor(options.cursorColor || '#c9a84c');
    }
  }

  #setupCursor(color) {
    document.body.style.cursor = 'none';
    this.#cursor = document.createElement('div');
    this.#cursor.style.cssText = `
      width: 8px; height: 8px;
      background: ${color};
      border-radius: 50%;
      position: fixed; top: 0; left: 0;
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%,-50%);
      transition: transform 0.1s ease, width 0.15s, height 0.15s;
      mix-blend-mode: screen;
    `;
    document.body.appendChild(this.#cursor);

    const ring = document.createElement('div');
    ring.style.cssText = `
      width: 28px; height: 28px;
      border: 1.5px solid ${color};
      border-radius: 50%;
      position: fixed; top: 0; left: 0;
      pointer-events: none;
      z-index: 9998;
      transform: translate(-50%,-50%);
      transition: transform 0.2s ease;
      opacity: 0.5;
    `;
    document.body.appendChild(ring);

    window.addEventListener('mousemove', e => {
      this.#cursor.style.left = e.clientX + 'px';
      this.#cursor.style.top  = e.clientY + 'px';
      ring.style.left = e.clientX + 'px';
      ring.style.top  = e.clientY + 'px';
    });
  }

  // ─── Public authoring API ──────────────────────────────────────────────────

  /**
   * Define a scene.
   *
   * @param {string} name - Unique scene identifier
   * @param {Object} def
   * @param {Array}  def.layers  - Depth layers: [{ z, style, html, animate }]
   * @param {Array}  def.objects - Interactable objects: [{ id, z, x, y, html, action, condition }]
   * @param {Function} def.onEnter - Called after scene loads: (state, api) => void
   */
  scene(name, def) {
    this.#scenes.set(name, def);
    return this;
  }

  /**
   * Define an action handler.
   *
   * @param {string} name - Action identifier
   * @param {Function} handler - (state, { go, say, choice, flash }) => void
   */
  action(name, handler) {
    this.#actions.set(name, handler);
    return this;
  }

  /**
   * Start the game at a named scene.
   */
  async start(sceneName) {
    this.#engine.mount();
    await this.#loadScene(sceneName, 'fade-in-only');
  }

  // ─── Private scene management ──────────────────────────────────────────────

  async #loadScene(name, transitionType = 'fade') {
    const def = this.#scenes.get(name);
    if (!def) throw new Error(`[PlanespaceGame] Unknown scene: "${name}"`);

    // Transition out
    if (this.#currentScene && transitionType !== 'fade-in-only') {
      const prevDef = this.#scenes.get(this.#currentScene);
      if (prevDef?.onExit) await prevDef.onExit(this.#state, this.#makeAPI());
      await this.#transition.fadeOut();
    }

    // Build scene
    this.#sceneEl.innerHTML = '';
    for (const layer of (def.layers || [])) this.#renderLayer(layer);
    for (const obj   of (def.objects || []))  this.#renderObject(obj);
    this.#engine.refresh();

    this.#currentScene = name;

    // Transition in
    await this.#transition.fadeIn();

    // onEnter
    if (def.onEnter) await def.onEnter(this.#state, this.#makeAPI());
  }

  #renderLayer(layer) {
    const el = document.createElement('div');
    el.setAttribute('data-z', layer.z ?? 0);
    if (layer.id) el.id = layer.id;
    if (layer.className) el.className = layer.className;
    el.style.cssText = `position:absolute;inset:0;${layer.style || ''}`;
    if (layer.html) el.innerHTML = layer.html;
    this.#sceneEl.appendChild(el);
  }

  #renderObject(obj) {
    // Check condition
    if (obj.condition && !obj.condition(this.#state)) return;

    const el = document.createElement('div');
    el.setAttribute('data-z', obj.z ?? 0);
    if (obj.id) el.id = `obj-${obj.id}`;
    el.style.cssText = `
      position: absolute;
      left: ${obj.x || '50%'};
      top:  ${obj.y || '50%'};
      transform: translate(-50%, -50%);
      ${obj.action ? 'cursor: pointer;' : ''}
      ${obj.style || ''}
    `;
    if (obj.html) el.innerHTML = obj.html;

    if (obj.label) {
      const hint = document.createElement('div');
      hint.style.cssText = `
        position: absolute;
        bottom: calc(100% + 8px);
        left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.8);
        color: #c9a84c;
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.65rem;
        letter-spacing: 0.12em;
        padding: 4px 10px;
        border-radius: 4px;
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.15s;
        pointer-events: none;
        text-transform: uppercase;
      `;
      hint.textContent = obj.label;
      el.appendChild(hint);
      el.addEventListener('mouseenter', () => hint.style.opacity = '1');
      el.addEventListener('mouseleave', () => hint.style.opacity = '0');
    }

    if (obj.action) {
      if (typeof obj.action === 'function') {
        el.addEventListener('click', () => obj.action(this.#state, this.#makeAPI()));
      } else {
        el.addEventListener('click', () => {
          const handler = this.#actions.get(obj.action);
          if (handler) handler(this.#state, this.#makeAPI());
          else console.warn(`[PlanespaceGame] No action registered: "${obj.action}"`);
        });
      }
    }

    this.#sceneEl.appendChild(el);
  }

  // ─── API passed into handlers ──────────────────────────────────────────────

  #makeAPI() {
    return {
      /** Navigate to a scene */
      go: (scene) => this.#loadScene(scene),

      /** Show dialogue lines: [{ speaker?, text }] */
      say: (lines) => this.#dialogue.say(lines),

      /** Show choice prompt */
      choice: (prompt, options) => this.#dialogue.choice(prompt, options),

      /** Flash the screen */
      flash: (color, ms) => this.#transition.flash(color, ms),

      /** Current game state */
      state: this.#state,

      /** Refresh scene objects (after state change that affects conditions) */
      refresh: () => this.#loadScene(this.#currentScene, 'fade-in-only'),
    };
  }

  get state()       { return this.#state; }
  get currentScene(){ return this.#currentScene; }
}

export default PlanespaceGame;
