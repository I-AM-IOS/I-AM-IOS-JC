// ─────────────────────────────────────────────────────────────────────────────
// I-AM-REKERNEL Canonical Closed Spec v3.1
// §2 Total State Semantics · §3 Event Model · §5 Trap Surface
// ─────────────────────────────────────────────────────────────────────────────
// no_std + alloc for WASM portability; no Option at state boundaries.

#![allow(dead_code)]
extern crate alloc;
use alloc::{string::String, vec::Vec, collections::BTreeMap};
use serde::{Deserialize, Serialize};

// ── §2.1 Hash commitment ─────────────────────────────────────────────────────

/// SHA-256 output — 32 bytes, content-addressed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Hash32(pub [u8; 32]);

impl Hash32 {
    pub fn zero() -> Self { Hash32([0u8; 32]) }
    pub fn is_zero(&self) -> bool { self.0 == [0u8; 32] }
    pub fn to_hex(&self) -> String {
        self.0.iter().map(|b| alloc::format!("{:02x}", b)).collect()
    }
}

// ── §6.1 Numeric domain ───────────────────────────────────────────────────────

/// Z_256: unsigned 256-bit integer (stored as u64 for Rust compat; upgrade
/// to [u64; 4] for full range when needed).  Arithmetic is always checked —
/// overflow → Revert per §6.2.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
pub struct Z256(pub u64);

impl Z256 {
    pub const ZERO: Self = Z256(0);
    pub const MAX:  Self = Z256(u64::MAX);

    pub fn checked_add(self, rhs: Self) -> Option<Self> {
        self.0.checked_add(rhs.0).map(Z256)
    }
    pub fn checked_sub(self, rhs: Self) -> Option<Self> {
        self.0.checked_sub(rhs.0).map(Z256)
    }
}

// ── §2.1 Total State S = (KV, BAL, META, TRACE, ROOT, VERSION) ───────────────

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    /// KV store — UTF-8 NFKC keys, BTreeMap guarantees sorted iteration.
    pub kv:      BTreeMap<String, Vec<u8>>,
    /// Account balances — non-negative Z_256.
    pub balance: BTreeMap<String, Z256>,
    /// Metadata namespace.
    pub meta:    BTreeMap<String, Vec<u8>>,
    /// Append-only event trace (content-addressed IDs).
    pub trace:   Vec<EventId>,
    /// Merkle root of current state commitment.
    pub root:    Hash32,
    /// Monotonic version counter (never decrements).
    pub version: u64,
    /// Governance block height — used by PO-G1 / PO-E1.
    pub block:   u64,
}

impl State {
    /// Genesis (empty) state — all fields defined, non-optional.
    pub fn genesis() -> Self {
        State {
            kv:      BTreeMap::new(),
            balance: BTreeMap::new(),
            meta:    BTreeMap::new(),
            trace:   Vec::new(),
            root:    Hash32::zero(),
            version: 0,
            block:   0,
        }
    }
}

// ── §3 Event Model ────────────────────────────────────────────────────────────

/// Content-addressed event identifier.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventId(pub Hash32);

/// Shard identifier (UTF-8, NFKC).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ShardId(pub String);

/// Actor DID — W3C DID format: `did:i-am:<method-specific>`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Actor(pub String);

/// §8 Capability Algebra.
/// Non-escalation invariant: Perm(child) ⊆ Perm(parent).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capability {
    pub scope:            Vec<String>,
    pub issuer:           Actor,
    pub subject:          Actor,
    pub delegation_depth: u32,
    pub parent_hash:      Hash32,
}

/// ECDSA signature (DER-encoded, 64–72 bytes).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signature(pub Vec<u8>);

/// §3.1 Canonical event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    pub id:               Hash32,
    pub seq:              u64,
    pub shard:            ShardId,
    pub actor:            Actor,
    pub capability:       Capability,
    pub module:           String,
    pub input:            Vec<u8>,
    pub prev_root:        Hash32,
    pub gas_limit:        u64,
    pub semantic_version: u32,
    pub signature:        Signature,
}

// ── §5.4 Trap codes ───────────────────────────────────────────────────────────

/// Every kernel trap normalises to one of these — no undefined trap surface.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrapCode {
    Overflow,             // §6.2
    OobRead,
    GasExhausted,         // §4.2
    InvalidImport,        // §5.2 — forbidden WASM host fn
    DivZero,
    InvalidSignature,     // §3.2 Sig(e)
    CapabilityViolation,  // §8 non-escalation
    InvalidRoot,          // §3.2 RootMatch(e,s)
    InvalidEvent,         // §3.2 general invalidity
    SunsetExpired,        // PO-E1
    ProofDebtExceeded,    // PO-E2
    QuorumNotMet,         // PO-G1
    InvalidFork,          // PO-G2
    BatchReplayMismatch,  // PO-N1
}

/// Total kernel result — every (e,s) pair has exactly one outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KernelResult {
    Commit(State),
    Revert(TrapCode),
    Reject(TrapCode),
}