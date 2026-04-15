# Sovereign Beast — Complete Wiring Guide

## System Overview

```
BROWSER SURFACES (5 HTML apps)
    index.html · app-builder-v2.html · attack.html · generate-value.html · index1.html
         │
         │ sovereignLog.emit() / subscribe()
         ▼
SOVEREIGN LOG  (sovereign-log.js / sovereign-log-inline.js)
    FNV-32 hash chain · deriveState() pure function · append-only ledger
         │
         │ BroadcastChannel('sovereign-os-bus')
         ▼
SOVEREIGN BUS  (sovereign-bus.js)
    Cross-tab / cross-surface event sync
         │
         │ subscribe() → promote
         ▼
SOVEREIGN NETWORK  (sovereign-network.js)
    PeerJS gossip · >2/3 quorum finality · IndexedDB persistence
         │                         │
         │ verifyEvent (I1–I6)     │ program dispatch
         ▼                         ▼
REKERNEL (TypeScript)         UDCSEF FABRIC (generate-value.html)
    6-lock kernel                 JSONFlow executor
    BFT consensus                 P2P compute dispatch
    slashing / safety proofs      sovereign-compute-bridge.js
         │
         │ kernel_apply / kernel_replay (WASM ABI)
         ▼
RUST WASM KERNEL  (wasm-kernel/)
    δ(e,s) → KernelResult  (total, no panics)
    SHA-256 content addressing
    13/13 proof obligations CLOSED
```

---

## Quick Start (no build needed)

```bash
node server.js          # serves on http://localhost:3000
node test-kernel.js     # run bridge smoke tests (6/6 should pass)
```

Open multiple browser tabs — they share the live event bus automatically.

---

## Build the Rust WASM Kernel

The kernel lives in `wasm-kernel/`. It requires a Rust toolchain.

### Prerequisites

```bash
# Install Rust (if not installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add WASM target
rustup target add wasm32-unknown-unknown
```

### Build

```bash
# Run all 13 proof-obligation tests (native)
cd wasm-kernel
cargo test

# Build WASM binary
cargo build --release --target wasm32-unknown-unknown
# Output: wasm-kernel/target/wasm32-unknown-unknown/release/rekernel_kernel.wasm

# Run PO status report
cargo run --release
```

### Load in Browser / Node.js

```javascript
// Node.js (see kernel-client.js for full wrapper)
const wasmBytes = fs.readFileSync('wasm-kernel/target/wasm32-unknown-unknown/release/rekernel_kernel.wasm');
const { instance } = await WebAssembly.instantiate(wasmBytes, {});

// Apply event
const state  = JSON.stringify(genesisState());
const event  = JSON.stringify(mintEvent);
const result = kernel.apply(event, state);  // { ok: true, result: {...} }
```

---

## Compile TypeScript Rekernel (optional)

```bash
npm run build:rekernel
# Output: rekernel-dist/
```

The browser bridges (`sovereign-ledger-bridge.js`, `sovereign-compute-bridge.js`)
implement identical guarantees in plain JS — no compile step required.

---

## Key Invariants

```
VM_stateₙ = deriveState(eventLog[0..n])          sovereign-log
T_i = hash(T_{i-1}, E_i, S_i)                    sovereign-ledger-bridge
canonical order = sort(events, by hash)            rekernel core/ordering.ts
finality requires >2/3 quorum acknowledgement      sovereign-network
compute is deterministic: same IR → same output    sovereign-compute-bridge
δ(e,s) is total: every (e,s) → defined result     wasm-kernel/transition.rs
```

---

## Surfaces

| URL | Surface | Role |
|---|---|---|
| `/` | Portal | Live event stream · ledger stats · launch pad |
| `/apps/app-builder-v2.html` | App Builder | NL → JSONFlow → code |
| `/apps/attack.html` | Attack Command | Smart contract & security audit |
| `/apps/generate-value.html` | UDCSEF Fabric | P2P distributed compute |
| `/apps/index1.html` | Genesis | 3-stage compilation pipeline |

---

## Wasm Kernel Modules

```
wasm-kernel/src/
├── lib.rs               ← crate root, re-exports all public API
├── main.rs              ← native binary: PO status report + smoke tests
├── types/mod.rs         ← State, Event, TrapCode, KernelResult, Hash32, Z256
├── kernel/
│   ├── transition.rs    ← δ(e,s) → KernelResult (total transition function)
│   ├── encoding.rs      ← deterministic encoding, SHA-256 state/transition roots
│   └── invariants.rs    ← Γ: balance bounds, root, trace monotonicity, cap non-escalation
├── boundary/mod.rs      ← BDE v4.0: BdeAdapter, CryptoProvider, StorageAdapter
├── governance/mod.rs    ← GovernanceLedger, ForkRegistry, quorum_threshold (PO-G1/G2)
├── emergency/mod.rs     ← SunsetPolicy, ProofDebtLedger (PO-E1/E2)
├── network/mod.rs       ← EventBatch, ReplayVerifier, StateSnapshot (PO-N1)
├── verification/mod.rs  ← 13-PO test harness (PO-B1 through PO-S1)
└── wasm_abi/mod.rs      ← WASM export surface: kernel_apply, kernel_replay, etc.
```

---

## Proof Obligations — All 13 CLOSED

| PO | Description | Mechanism |
|---|---|---|
| PO-B1 | Determinism | δ(e,s) = δ(e,s) always |
| PO-B2 | Replay Equality | replay(events, s0) is idempotent |
| PO-B3 | Invariant Preservation | Γ(s) ∧ Commit → Γ(s') |
| PO-B4 | Crypto Provider Parity | sha256 is pure |
| PO-T2 | Cap Non-Escalation | child.scope ⊆ parent.scope |
| PO-G1 | Quorum Enforcement | ≥⌈2/3⌉ validators required |
| PO-G2 | Valid Fork Rule | ancestor must be known + quorum |
| PO-E1 | Sunset Enforcement | block ≥ sunset → halt |
| PO-E2 | Proof Debt | unresolved ≥ MAX → read-only |
| PO-N1 | Batch Replay Determinism | identical batches → same state |
| PO-C1 | Root Commitment | root changes iff state changes |
| PO-C2 | Trace Append-Only | trace never shrinks |
| PO-S1 | Total Transition | δ defined for all (e,s) |

---

## Optional: Ollama (local AI)

`kernel-adapter.js` and intel surfaces talk to Ollama at `http://localhost:11434`.

```bash
# https://ollama.com
ollama pull llama3
ollama serve
```

Without Ollama all surfaces work — `KERNEL_*` events just won't fire.
