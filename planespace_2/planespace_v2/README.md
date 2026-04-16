# planespace

**A DOM-native perceptual compositor.**

The missing layer between CSS transforms and WebGL. Planespace adds believable parallax depth to standard HTML by reading `data-z` attributes you author, building a live depth map, and warping the rendered frame per-pixel based on viewer position — with zero layout mutation, no scene graph, and full pointer-event passthrough.

```html
<section data-z="-300">Background layer</section>
<article data-z="0">Content</article>
<nav data-z="80">Foreground HUD</nav>
```

```js
import { Planespace } from 'planespace';
const ps = new Planespace({ maxAngle: 7 });
await ps.mount(document.body);
```

---

## Installation

```bash
npm install planespace
```

Or use directly from a CDN:

```html
<script type="module">
  import { Planespace } from 'https://cdn.jsdelivr.net/npm/planespace/dist/planespace.min.js';
</script>
```

---

## 60-Second Quickstart

**1. Add depth attributes to your HTML:**

```html
<div class="hero">
  <div data-z="-400" class="sky">Sky</div>
  <div data-z="-200" class="mountains">Mountains</div>
  <div data-z="0"    class="ground">Ground</div>
  <div data-z="60"   class="title">Title</div>
</div>
```

**2. Mount planespace:**

```js
import { Planespace } from 'planespace';

const ps = new Planespace({
  inputMode: 'mouse',   // or 'gyro', 'both', 'none'
  maxAngle: 7,          // max scene tilt in degrees
  lerpFactor: 0.06,     // camera smoothing (0=instant)
});

await ps.mount(document.querySelector('.hero'));
```

**3. That's it.** Move your mouse. Your layers now have depth.

---

## Core Concepts

### Planes

Any HTML element with a `data-z` attribute is a **plane** — a layer in Z-space. The value is in the same units as `depthRange` (default: -600 to 100).

```html
<div data-z="-500">Far background</div>   <!-- recedes most -->
<div data-z="0">Midground</div>
<div data-z="80">Foreground</div>          <!-- moves most with viewer -->
```

You can also use **named layers** for clarity:

```js
const ps = new Planespace({
  layers: { sky: -500, bg: -200, content: 0, hud: 80 }
});
```

```html
<div data-z="sky">Sky</div>
<div data-z="hud">Floating nav</div>
```

### Depth

The `depthRange` option defines the full Z extent of your scene. Values outside this range are clamped.

```js
// Default: -600 to 100
depthRange: [-600, 100]

// Deep scene
depthRange: [-1200, 200]
```

### Projection

Planespace generates a **depth texture** — a per-pixel float map where each pixel's value is the normalized Z of the frontmost element at that screen position. This texture drives the parallax warp: near pixels (high Z) shift more with viewer angle than far pixels (low Z).

The projection is deterministic and documented in [SPEC.md](./SPEC.md#i-6-deterministic-depth-projection).

### Warp

Two warp modes are available:

| Mode | Mechanism | Quality | Cost |
|---|---|---|---|
| `reproject` | WebGL2 per-pixel warp | High | Requires scene capture |
| `transform` | CSS `preserve-3d` + `translateZ` | Good | Near zero |

`reproject` is the default and falls back to `transform` automatically on browsers without WebGL2.

---

## API Reference

### `new Planespace(options)`

```ts
const ps = new Planespace({
  // Input
  inputMode: 'mouse',      // 'mouse' | 'gyro' | 'both' | 'none'
  maxAngle: 6,             // scene tilt range in degrees
  lerpFactor: 0.06,        // camera lag (0=instant, 0.5=very laggy)
  inputDeadzone: 0.03,     // center dead zone radius (0–1)

  // Depth
  depthAttr: 'data-z',     // HTML attribute name
  depthRange: [-600, 100], // [near, far] Z range
  layers: {},              // named layer aliases

  // Warp
  warpMode: 'reproject',   // 'reproject' | 'transform' | 'hybrid'

  // Shader (reproject mode)
  shader: {
    warpStrength: 0.015,       // parallax intensity
    edgeClamping: true,        // prevent UV wrap artifacts
    chromaticOffset: false,    // RGB channel split effect
    vignetteStrength: 0.3,     // edge darkening at high angles
    temporalSmoothing: 0.85,   // depth map blending
  },

  // Compositor (reproject mode)
  compositor: {
    targetFPS: 60,
    captureResolution: 1.0,  // 0.5 = half-res capture, lower cost
  },

  // CSS (transform mode)
  perspective: 900,          // CSS perspective depth in px

  // Debug
  debug: false,              // show debug overlay
});
```

### `ps.mount(root?)` → `Promise<void>`

Activates planespace on a DOM subtree. Scans for `[data-z]` elements, initializes the render pipeline, and starts the render loop.

```js
await ps.mount(document.body);         // whole page
await ps.mount(document.querySelector('.hero')); // scoped
```

Fires `'ready'` after the first frame.

### `ps.unmount()`

Deactivates planespace, restores all DOM mutations, stops the render loop, and releases GPU resources. Safe to call when not mounted.

### `ps.refresh()`

Re-scan for `[data-z]` elements after dynamic DOM changes. Call after adding or removing depth elements:

```js
const newEl = document.createElement('div');
newEl.setAttribute('data-z', '60');
container.appendChild(newEl);
ps.refresh(); // picks up the new element
```

### `ps.setDepth(el, z)`

Set an element's depth programmatically:

```js
ps.setDepth(myCard, 80); // equivalent to myCard.setAttribute('data-z', '80')
```

### `ps.setViewer(x, y)`

Override the viewer position manually. Useful for scroll-driven or touch-driven parallax:

```js
// x, y in -1..1 range
ps.setViewer(0.3, -0.1);
```

### `ps.configure(patch)`

Update live configuration without remounting:

```js
ps.configure({ maxAngle: 12, lerpFactor: 0.04 });
```

Structural options (`warpMode`, `depthAttr`) require `unmount()` + `remount()`.

### `ps.on(event, handler)` → `() => void`

Subscribe to events. Returns an unsubscribe function:

```js
const off = ps.on('frame', ({ rx, ry, frameCount }) => {
  console.log(`viewer: ${rx.toFixed(2)}, ${ry.toFixed(2)}`);
});

// Later:
off(); // remove listener
```

**Events:**

| Event | Payload | When |
|---|---|---|
| `'ready'` | — | First frame rendered |
| `'frame'` | `{ rx, ry, timestamp, frameCount }` | Every frame |
| `'depthchange'` | `{ element, oldZ, newZ }` | Any `data-z` changes |
| `'pause'` | — | Render loop paused |
| `'resume'` | — | Render loop resumed |
| `'error'` | `Error` | Unrecoverable runtime error |

### Getters

```js
ps.mounted          // boolean
ps.paused           // boolean
ps.warpMode         // 'reproject' | 'transform'
ps.viewer           // { x: number, y: number }
ps.frameCount       // number
ps.depthElementCount // number
ps.config           // configuration snapshot
ps.captureStrategy  // 'captureStream' | 'html2canvas' | 'transform' | null
ps.getPerformanceMetrics() // { fps, frameCount, uptimeMs }
```

---

## Integrations

### React

```jsx
import { usePlanespace } from 'planespace/react';

function HeroSection() {
  const { ref, viewer, mounted } = usePlanespace({ maxAngle: 8 });

  return (
    <section ref={ref}>
      <div data-z="-300">Background</div>
      <h1 data-z="60">Foreground Title</h1>
    </section>
  );
}
```

Or use the component wrapper:

```jsx
import { PlanespaceScene } from 'planespace/react';

<PlanespaceScene maxAngle={8} inputMode="mouse">
  <h1 data-z="60">Title</h1>
</PlanespaceScene>
```

### Web Components

```html
<script type="module" src="planespace/integrations/web-components/index.js"></script>

<planespace-scene max-angle="8" input-mode="mouse">
  <h1 data-z="60">Title</h1>
  <div data-z="-300">Background</div>
</planespace-scene>
```

```js
document.querySelector('planespace-scene').addEventListener('ps-ready', () => {
  console.log('depth active');
});
```

### Vue

```vue
<template>
  <div ref="sceneRef">
    <div data-z="-300">Background</div>
    <h1 data-z="60">Title</h1>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { Planespace } from 'planespace';

const sceneRef = ref(null);
let ps;

onMounted(async () => {
  ps = new Planespace({ maxAngle: 7 });
  await ps.mount(sceneRef.value);
});

onUnmounted(() => ps?.unmount());
</script>
```

### SSR-safe pattern

```js
// Only initialize on the client
if (typeof window !== 'undefined') {
  const { Planespace } = await import('planespace');
  const ps = new Planespace({ maxAngle: 7 });
  await ps.mount(document.getElementById('hero'));
}
```

---

## Advanced Tuning

### Performance

For large scenes (100+ depth elements), lower the capture resolution:

```js
compositor: { captureResolution: 0.5 }
```

For scenes that don't need real-time warp, use `transform` mode:

```js
warpMode: 'transform'  // ~0.3ms/frame JS cost at 50 planes
```

Pause planespace when the scene is off-screen:

```js
const observer = new IntersectionObserver(([entry]) => {
  entry.isIntersecting ? ps.resume() : ps.pause();
});
observer.observe(heroSection);
```

### Depth Map Quality

The depth texture resolution matches the output canvas (full viewport by default). For the warp to look clean, ensure overlapping elements have distinct Z values — elements at the same Z will blend at borders.

Temporal smoothing (`shader.temporalSmoothing`) reduces depth map flickering on dynamically changing scenes at the cost of a small latency in depth updates.

### Custom Shader

For `reproject` mode, you can provide a custom fragment shader:

```js
const ps = new Planespace({
  warpMode: 'reproject',
  shader: {
    fragment: `#version 300 es
    precision highp float;
    uniform sampler2D T_scene;
    uniform sampler2D T_depth;
    uniform vec2 viewerAngle;
    uniform float warpStrength;
    in vec2 vUV;
    out vec4 fragColor;
    void main() {
      float depth = texture(T_depth, vUV).r;
      vec2 uv = vUV + viewerAngle * depth * warpStrength;
      fragColor = texture(T_scene, clamp(uv, 0.001, 0.999));
    }`
  }
});
```

---

## Performance Notes

### Transform mode benchmarks

| Plane count | Avg JS cost | Sustained FPS |
|---|---|---|
| 20 | ~0.18ms | 60fps |
| 50 | ~0.31ms | 60fps |
| 100 | ~0.55ms | 60fps |
| 200 | ~1.1ms | 60fps |
| 500 | ~2.8ms | 60fps |

*Tested on Chrome 120, M2 MacBook Air. Your numbers will vary.*

The primary cost at high plane counts is `getBoundingClientRect()` in the depth texture generator. This is only called when the depth registry is dirty (element added/removed or `refresh()` called).

Per-frame cost in transform mode is dominated by CSS composite — not Planespace's JS.

---

## FAQ

**When should I NOT use planespace?**

- When your layout is already using `preserve-3d` CSS — the two will conflict
- In `reproject` mode, if your scene has text that must remain pixel-sharp at all viewer angles (warp will sub-pixel blur text)
- On heavily animated UIs where DOM changes happen every frame (high depth-registry churn)
- When accessibility is the primary concern and motion must be zero (use `inputMode: 'none'` and never call `mount()`)

**Does it work with React / Vue / Svelte?**

Yes. Use the React integration (`planespace/react`), the Web Components integration, or mount manually in a lifecycle hook. Planespace is framework-agnostic.

**Does it work on mobile?**

Yes. Use `inputMode: 'gyro'` or `'both'` for device orientation input. iOS requires a user gesture before gyroscope permission is granted — Planespace handles this automatically.

**Does it require a build step?**

No. It ships as ES modules and can be used directly from a CDN via `<script type="module">`.

**Why not just use Three.js?**

Three.js takes over rendering entirely — your HTML becomes canvas pixels and loses accessibility, text rendering, CSS, and pointer events. Planespace enhances HTML; it doesn't replace it.

**What browsers are supported?**

For `transform` mode: all modern browsers (Chrome, Firefox, Safari, Edge).  
For `reproject` mode: browsers with WebGL2 support (Chrome 56+, Firefox 51+, Safari 15+).

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

---

## License

MIT — see [LICENSE](./LICENSE).
