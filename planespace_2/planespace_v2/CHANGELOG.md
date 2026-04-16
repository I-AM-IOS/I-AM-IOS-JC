# Changelog

All notable changes to this project are documented here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.0.0] — 2024-01-01

### Summary

First stable release. API surface is frozen per SPEC.md. All public APIs are covered by semver guarantees.

### Added

**Core**
- `Planespace` class with full public getter surface (`mounted`, `paused`, `warpMode`, `frameCount`, `viewer`, `config`, `depthElementCount`, `captureStrategy`)
- Private class fields (`#`) for all internal state — no underscore leakage
- `configure()` method for live non-structural option updates
- `getPerformanceMetrics()` returning `{ fps, frameCount, uptimeMs }`
- Input validation on construction with descriptive errors in dev mode
- Dev-mode warnings via `DevTools.js` (`warn()`, `validate()`, `invariant()`)
- `aria-hidden="true"` + `role="presentation"` on output canvas for accessibility

**Events**
- `'frame'` event now includes `frameCount` in payload
- `'error'` event type added to TypeScript declarations

**API Stability**
- `refresh()` replaces the vague `update()` name (backward-compatible — `update()` kept as deprecated alias)
- `on()` now emits a dev warning for unrecognized event names

**Integrations**
- `integrations/react/` — `usePlanespace` hook + `PlanespaceScene` component with TypeScript types
- `integrations/web-components/` — `PlanespaceElement` custom element + `register()` helper

**SpatialLayout**
- Fully decoupled from Planespace internals — uses only the public `setDepth()` API
- Defensive check: logs a descriptive warning for unknown slot names

**TypeScript**
- Comprehensive type coverage for all public API, options, events, and return types
- `configure()` uses `Pick<>` to constrain to live-updatable options only
- `DepthRegistry.entries` typed as `ReadonlyArray`
- `EventEmitter.listenerCount` getter added

**Documentation**
- `SPEC.md` — formal runtime contract with core invariants and versioning policy
- `README.md` — infrastructure-grade: installation, quickstart, API reference, integrations, FAQ
- `docs/benchmarks.html` — live in-browser benchmark page with frame budget analysis
- Three polished copy-paste examples: storytelling, product hero, dashboard

### Changed

- `SpatialLayout` no longer accesses `planespace._depthRegistry` directly

### Deprecated

- `update()` — use `refresh()` instead. Will be removed in v2.0.

---

## [0.9.0] — Pre-release

Initial working implementation. API surface was unstable. Not covered by semver guarantees.

---

## Roadmap

### 1.1.0 (planned)

- `ps.clearViewer()` public API to cancel external viewer override
- Scroll-position input driver (`inputMode: 'scroll'`)
- `SpatialLayout.unplace()` to remove element positioning

### 1.2.0 (planned)

- `warpMode: 'hybrid'` fully implemented (reproject with transform fallback per element)
- `DepthRegistry.setRange()` for live depthRange updates

### 2.0.0 (future)

- Remove deprecated `update()` method
- Potential: named layer aliases in `depthAttr` via data attributes (e.g. `data-z-layer="sky"`)
- Review and possibly expand stable API surface based on community usage

---

## Breaking Change Policy

A breaking change requires a MAJOR version bump. See [SPEC.md](./SPEC.md#versioning-policy) for the full policy.

The minimum deprecation window is one full minor version before removal.
