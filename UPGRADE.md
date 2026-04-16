# I-AM-IOS v3.0 — Upgrade & Shipping Checklist

This document describes every change made in the v3.0 upgrade and the exact
steps required to get the system into production.

---

## What changed

### 1. `sovereign-network.js` — full rewrite of consensus layer

| Area | v2 (before) | v3 (now) |
|------|-------------|----------|
| Quorum tracking | Peer-headcount `Set` — a cluster of low-stake nodes could hit 0.67 before high-stake validators spoke | Delegated to `ESAConsensusManager` → `rekernel-esa-bridge.js`, which uses `ValidatorSetSnapshot` and stake-weighted `countVotingPower()` |
| Duplicate-ack guard | Implicit (Set dedup by peerId) | Explicit per-`validatorId` dedup inside `processAcknowledgement()` |
| `FORK_PROOF` handler | `console.warn` stub | Full `resolveFork()` + `verifyForkResolution()` via `rekernel-fork-bridge.js`; emits `FORK_RESOLVED` into sovereign-log |
| Height / finality | None | `advanceToNextHeight()` called on every snapshot boundary; emits `ESA_HEIGHT_ADVANCED` |
| ACK message format | Raw peer ID string | Full `EventAcknowledgement` struct (`eventHash`, `validatorId`, `height`, `timestamp`, `ackHash`, `signature`) — backward-compatible, remote peers without the struct get a synthesized one |
| New event types | — | `FORK_RESOLVED`, `ESA_HEIGHT_ADVANCED` |
| New network API | — | `net.getCanonicalSet()`, `net.getESAHeight()` |

### 2. `rekernel-esa-bridge.js` — new file

Plain ES-module port of `rekernel/consensus/event_set_agreement.ts` +
`rekernel/consensus/validators.ts`. **No TypeScript compile step required.**
Imported directly by `sovereign-network.js`.

### 3. `rekernel-fork-bridge.js` — new file

Plain ES-module port of `rekernel/network/fork_resolution.ts`.
Handles `FORK_PROOF` gossip messages.

### 4. `rekernel/tsconfig.json` + `dmr-upgrade/tsconfig.json` — new files

Correct compiler options so `npm run build:rekernel` and `npm run build:dmr`
produce `ESNext` modules in `rekernel-dist/` and `dmr-dist/` respectively.

### 5. `package.json` — updated

Added `build`, `build:rekernel`, `build:dmr`, `dev` (watch mode), `check` scripts.
Version bumped to `3.0.0`.

### 6. `.env.example` — new file

Replaces the old `.env` with all placeholders documented.

---

## Step-by-step: getting to production

### Step 1 — Drop in the new files

Copy these files into your `I-AM-IOS-V-Production/` directory, replacing the
originals where they exist:

```
sovereign-network.js          ← replaces existing
rekernel-esa-bridge.js        ← new
rekernel-fork-bridge.js       ← new
package.json                  ← replaces existing
rekernel/tsconfig.json        ← new
.env.example                  ← new (copy to .env and fill in)
```

Copy `dmr-upgrade/tsconfig.json` into your `dmr-upgrade/` directory.

### Step 2 — Configure your environment

```bash
cp .env.example .env
```

Edit `.env`:

- Set `VALIDATOR_ENDPOINT` to your deployed validator URL.
  If you don't have one yet, leave it blank — the system runs in pure P2P mode.
- Set `NODE_ID` to a stable identifier if you want persistent node identity.
  Leave as `auto` for ephemeral nodes.

Also update `network-config.js` — replace the `xxxx` placeholder in
`VALIDATOR_ENDPOINT` with the same URL:

```js
export const VALIDATOR_ENDPOINT = 'https://your-validator.up.railway.app';
```

### Step 3 — Compile TypeScript (required for rekernel & dmr-upgrade)

The `rekernel/` and `dmr-upgrade/src/` directories contain TypeScript that
Node.js cannot run directly. Compile them:

```bash
cd I-AM-IOS-V-Production
npm run build
```

This produces:
- `rekernel-dist/` — compiled rekernel modules
- `dmr-dist/` — compiled DMR overlay routing

The JS bridges (`rekernel-esa-bridge.js`, `rekernel-fork-bridge.js`) do **not**
need compilation — they are already plain JavaScript.

### Step 4 — Run the import check

```bash
npm run check
```

You should see:
```
[check] sovereign-network.js imports OK [ 'attachNetwork', 'emit', 'getLog', ... ]
```

If you see a module-not-found error for `rekernel-esa-bridge.js` or
`rekernel-fork-bridge.js`, confirm the two bridge files are in the same
directory as `sovereign-network.js`.

### Step 5 — Run the test suite

```bash
npm test
```

All tests in `test-complete-system.js` should pass. If any fail, check:

- `sovereign-log.js` EVENT_TYPES must include `FORK_RESOLVED` and
  `ESA_HEIGHT_ADVANCED` — add them if missing (they are emitted by
  `sovereign-network.js` and need to be registered).

  In `sovereign-log.js`, add to `EVENT_TYPES`:
  ```js
  FORK_RESOLVED:       'FORK_RESOLVED',
  ESA_HEIGHT_ADVANCED: 'ESA_HEIGHT_ADVANCED',
  ```

### Step 6 — Validator endpoint (for Mode 1 / hybrid operation)

If you want the full hybrid network (Mode 1 = validator, Mode 2 = P2P fallback):

1. Deploy a validator node (Railway, Fly.io, or your own VPS).
2. Set `VALIDATOR_ENDPOINT` in `.env` and `network-config.js`.
3. Restart: `npm start`
4. The server startup log will confirm:
   ```
   ✓ Validator (L4.5):  https://your-validator.up.railway.app
   ```

Without a validator endpoint the system runs identically to v2 in pure P2P
mode. All the new consensus improvements (ESA, fork resolution) still apply —
they just run over the P2P gossip transport instead of the validator HTTP path.

### Step 7 — Optional: pass a validator set to `attachNetwork()`

To enable **full stake-weighted consensus** (instead of peer-count quorum),
pass your validators when calling `attachNetwork()` in your surface HTML:

```js
import { attachNetwork } from './sovereign-network.js';

const net = await attachNetwork({
  validators: [
    { id: 'validator-1', publicKey: '...', stake: 100, reputation: 1.0,
      isActive: true, joinedAtHeight: 0, slashCount: 0 },
    { id: 'validator-2', publicKey: '...', stake: 100, reputation: 1.0,
      isActive: true, joinedAtHeight: 0, slashCount: 0 },
    { id: 'validator-3', publicKey: '...', stake: 100, reputation: 1.0,
      isActive: true, joinedAtHeight: 0, slashCount: 0 },
  ],
  quorum: 0.67,
});
```

Without a validator set, the system falls back to peer-count quorum (same
behaviour as v2), which is safe for a single-operator deployment.

---

## What is still deferred (post-v3)

| Item | Status | Notes |
|------|--------|-------|
| Ed25519 validator signatures | Reserved | `signature: ''` placeholder in ACK struct. Wire in when validator key infrastructure is live. |
| DMR routing integration in `sovereign-network-hybrid.js` | Deferred | `dmr-dist/routing/overlay-routing.js` is compiled but not yet imported in the hybrid layer. Add `import { computeCanonicalRouteSet } from '../dmr-dist/routing/overlay-routing.js'` and replace the ad-hoc routing logic. |
| Reputation decay & slashing | Deferred | `validators.ts` has `decayValidatorReputation()` and `slashValidator()` — wire into the ESA manager when your validator key infrastructure is live. |
| Gossip TTL / fanout limit | Deferred | `gossip.ts` has the full algorithm. Current relay is unbounded. |
| WASM kernel integration | Deferred | `wasm-kernel/` compiles standalone. Bridge to sovereign-log via `kernel-adapter.js`. |

---

## Verifying the upgrade worked

After `npm start`, open the browser console on any surface and run:

```js
const net = await import('./sovereign-network.js');
const inst = await net.attachNetwork();

console.log('ESA height:', inst.getESAHeight());
console.log('Canonical set:', inst.getCanonicalSet());
```

You should see `ESA height: 0` and an empty canonical set on a fresh node.
After emitting a few events and waiting for quorum acks, `getCanonicalSet()`
will show admitted events ordered by hash.
