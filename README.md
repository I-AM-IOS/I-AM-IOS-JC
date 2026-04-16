# Sovereign Compute Network

A sovereign substrate for distributed compute, intelligence, ledger, data,
and a replayable deterministic event-driven system.

## Quick start

```bash
node server.js          # start on port 3000
node server.js 8080     # start on port 8080
```

Then open **http://localhost:3000** — the portal dashboard.

No npm install needed. Pure Node.js stdlib server.

## Surfaces

| URL | Surface | Role |
|---|---|---|
| `/` | Portal | Live event stream · ledger stats · launch pad |
| `/apps/app-builder-v2.html` | App Builder | NL → JSONFlow → code |
| `/apps/attack.html` | Attack Command | Smart contract & security audit |
| `/apps/generate-value.html` | UDCSEF Fabric | P2P distributed compute |
| `/apps/index1.html` | Genesis | 3-stage compilation pipeline |

Open multiple surfaces in the same browser — they share a live event bus
via `BroadcastChannel('sovereign-os-bus')`.

## Architecture

```
SURFACES (5 HTML apps)
    ↓ sovereignLog.emit()
SOVEREIGN BUS   BroadcastChannel cross-tab sync
    ↓
SOVEREIGN LOG   Local truth engine — FNV-32 hash chain, pure deriveState()
    ↓ promote
SOVEREIGN NETWORK   PeerJS gossip + >2/3 quorum finality + IndexedDB ledger
    ↓                    ↓
REKERNEL            UDCSEF FABRIC
BFT consensus       P2P compute execution
locked kernel       JSONFlow program dispatch
```

## File map

```
sovereign-net/
├── server.js                  ← run this
├── index.html                 ← portal dashboard
├── package.json
├── test-kernel.js             ← node test-kernel.js to verify
│
├── sovereign-log.js           ← truth engine (module-based apps)
├── sovereign-log-inline.js    ← truth engine (standalone HTML apps)
├── sovereign-bus.js           ← BroadcastChannel cross-tab sync
├── sovereign-network.js       ← harness: PeerJS + finality + IndexedDB
├── sovereign-ledger-bridge.js ← rekernel event format + I1-I6 + chain
├── sovereign-compute-bridge.js← JSONFlow executor + UDCSEF dispatch
├── migration-shim.js          ← legacy state.js drop-in replacement
├── kernel-adapter.js          ← Ollama → 6-view analysis → log events
│
├── modules/
│   └── intel.wired.js         ← intel module wired to sovereign-log
│
├── apps/
│   ├── app-builder-v2.html
│   ├── attack.html
│   ├── generate-value.html
│   └── index1.html
│
└── rekernel/                  ← TypeScript source (compile with tsc)
    ├── core/                  ← 6-lock deterministic kernel
    ├── consensus/             ← BFT validators, slashing, safety proofs
    └── network/               ← gossip, partition, fork resolution, membership
```

## Optional: Ollama (local AI)

The kernel-adapter and intel surfaces talk to Ollama at `http://localhost:11434`.

```bash
# Install Ollama — https://ollama.com
ollama pull llama3     # or any model
ollama serve
```

Without Ollama, all surfaces work — KERNEL_* events just won't fire.

## Optional: compile rekernel TypeScript

```bash
npm run build:rekernel
```

Produces compiled JS in `rekernel-dist/`. The browser bridges
(`sovereign-ledger-bridge.js`) implement the same guarantees without
requiring a compile step.

## Key invariants

```
VM_stateₙ = deriveState(eventLog[0..n])          sovereign-log
T_i = hash(T_{i-1}, E_i, S_i)                    sovereign-ledger-bridge
canonical order = sort(events, by hash)           rekernel ordering
finality requires >2/3 quorum acknowledgement     sovereign-network
compute is deterministic: same IR → same output   sovereign-compute-bridge
```
