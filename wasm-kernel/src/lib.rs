// ─────────────────────────────────────────────────────────────────────────────
// I-AM-REKERNEL  Canonical Closed Spec v3.1  ·  K = (S, E, δ, Γ, C, P, V)
// ─────────────────────────────────────────────────────────────────────────────
#![cfg_attr(target_arch = "wasm32", no_std)]
#![forbid(unsafe_code)]
#![deny(overflowing_literals)]

// `alloc` is available as a built-in crate whether or not std is linked.
// Declaring it here makes `alloc::` paths resolve in all submodules on
// both wasm32 (no_std) and native (std) targets.
extern crate alloc;

pub mod types;
pub mod kernel;
pub mod boundary;
pub mod governance;
pub mod emergency;
pub mod network;
pub mod verification;
pub mod wasm_abi;

pub use types::{
    State, Event, EventId, ShardId, Actor, Capability, Signature,
    Hash32, Z256, TrapCode, KernelResult,
};
pub use kernel::transition::{delta, replay, is_valid, B_MAX, MAX_DELEGATION_DEPTH};
pub use kernel::encoding::{compute_state_root, compute_transition_root};
pub use kernel::invariants::{check_invariants, check_capability_non_escalation};
pub use boundary::{
    BdeAdapter, CryptoProvider, StorageAdapter,
    NullAdapter, Sha256Provider, MemoryStorage,
    Ed25519BdeAdapter, AuditEntry,
};
pub use governance::{GovernanceLedger, ConstitutionalChange, ForkRegistry, ForkProposal, quorum_threshold};
pub use emergency::{SunsetPolicy, ProofDebtLedger, MAX_PROOF_DEBT};
pub use network::{EventBatch, ReplayVerifier, StateSnapshot};
pub use wasm_abi::{apply, apply_batch, state_root_hex, version_string, KERNEL_SPEC_VERSION};
