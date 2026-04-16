# Planespace Runtime Specification

**Version:** 1.0.0  
**Status:** Stable

This document defines the Planespace runtime contract. Implementations and integrations may rely on every guarantee listed here across all minor versions. Breaking these invariants constitutes a semver major version bump.

---

## Core Invariants

These properties hold for the lifetime of any Planespace instance. They are not configuration — they are permanent constraints.

### I-1: DOM Authoritativeness

The DOM is always authoritative. Planespace reads layout from the browser's rendering engine via `getBoundingClientRect()` and `data-z` attributes. It never writes to `innerHTML`, never reorders children, and never changes element dimensions.

### I-2: No Scene Graph Takeover

Planespace does not replace the DOM with a retained scene graph. Elements remain regular HTML elements subject to normal CSS, accessibility, and pointer event rules. Planespace is a display enhancement, not a scene replacement.

### I-3: Pointer Events Preserved

The output canvas is rendered with `pointer-events: none`. All pointer, touch, keyboard, and focus events continue to target the original DOM elements as if Planespace were not present.

### I-4: No Forced Layout Mutation

In `transform` mode, Planespace applies `translateZ()` and `perspective` to the root container. No other layout properties (`width`, `height`, `display`, `position`, `margin`, `padding`) are modified. In `reproject` mode, no layout properties are modified at all.

### I-5: No Forced WebGL Dependency

WebGL2 is used when available and preferred. When WebGL2 is unavailable, Planespace automatically falls back to CSS `transform` mode without error. Applications must not assume the `reproject` warp mode is active without checking `ps.warpMode`.

### I-6: Deterministic Depth Projection

For any given set of `[data-z]` elements and viewer position `(rx, ry)`, the depth texture is deterministically computed. Elements with higher Z values occlude lower Z values in the depth map. Depth normalization uses the configured `depthRange` with linear interpolation:

```
normalizedDepth = (z - depthRange[0]) / (depthRange[1] - depthRange[0])
```

Clamped to `[0, 1]`.

---

## Public API Contract

### Stable Surface (semver-protected)

The following are the complete stable public API. External code may depend on all of these:

**Planespace class:**
- Constructor: `new Planespace(options)`
- Methods: `mount()`, `unmount()`, `refresh()`, `pause()`, `resume()`, `on()`, `setViewer()`, `setDepth()`, `configure()`, `getPerformanceMetrics()`
- Getters: `mounted`, `paused`, `warpMode`, `frameCount`, `viewer`, `config`, `depthElementCount`, `captureStrategy`

**SpatialLayout class:**
- Constructor: `new SpatialLayout(planespace, options)`
- Methods: `place()`, `defineSlot()`, `placeAt()`, `transitionZ()`, `destroy()`

**PlanespaceCore class:**
- Constructor: `new PlanespaceCore(options)`
- Methods: `renderFrame()`, `destroy()`

**Exports:**
- `Planespace`, `PlanespaceCore`, `DepthRegistry`, `EventEmitter`, `SpatialLayout`, `WarpShader`, `VERSION`

**Events:**
- `'ready'`, `'frame'`, `'depthchange'`, `'pause'`, `'resume'`, `'error'`

### Private / Internal Surface (NOT part of public API)

Any symbol prefixed with `#` (private class fields) is internal. These may change without notice. Do not access them from external code.

Violation of this rule constitutes reliance on undefined behavior.

---

## Versioning Policy

Planespace follows [Semantic Versioning 2.0.0](https://semver.org).

| Change type | Version bump |
|---|---|
| Breaking change to the stable public API | MAJOR |
| Backward-compatible new feature | MINOR |
| Bug fix, performance improvement | PATCH |
| Documentation, types, internals | PATCH |

### Breaking Change Definition

A breaking change is any modification that requires existing correct code to be updated to continue working. This includes:

- Removing a method, getter, or event from the stable surface
- Changing the signature of a stable method in a non-backward-compatible way
- Changing an invariant listed in this spec
- Removing or renaming a named export

### Deprecation Policy

Before removing any stable API surface, it must be:
1. Marked `@deprecated` in JSDoc and TypeScript types
2. Emitting a `console.warn` in dev mode when called
3. Listed in `CHANGELOG.md` under the deprecation release
4. Present for at least one full minor version before removal

---

## Scope Boundaries

Planespace will **not** do the following (now or in future versions):

- Take over layout management (use CSS or your framework for that)
- Provide a 3D scene graph or retained render tree
- Manage application state
- Provide built-in scroll-driven animation (use the Web Animations API or a scroll library)
- Replace CSS transitions or animations
- Add audio, physics, or game loop functionality
- Render arbitrary vector or raster graphics
- Require a build step to use

Maintaining a clear scope boundary is part of the specification. Features that fall outside this scope will be declined or deferred to the ecosystem.

---

## Implementation Requirements

Implementations wishing to claim Planespace compatibility must:

1. Respect all invariants in the Core Invariants section
2. Implement the full stable public API surface
3. Produce deterministic depth projection per I-6
4. Expose the `VERSION` string
5. Fall back gracefully to transform mode when WebGL2 is unavailable

---

*Specification maintained by the Planespace project. Proposed changes should be submitted as GitHub issues with the label `spec-change`.*
