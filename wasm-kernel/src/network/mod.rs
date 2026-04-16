// ─────────────────────────────────────────────────────────────────────────────
// Network Boundary — Batch Canonicalization & Replay Determinism
// PO-N1: identical event batches on identical initial states → identical result
// PO-B2: replay equality across nodes
// ─────────────────────────────────────────────────────────────────────────────


extern crate alloc;
use alloc::vec::Vec;
use crate::types::{Event, State, TrapCode, Hash32};
use crate::kernel::transition::replay;
use crate::kernel::encoding::{encode_event, compute_state_root};
use sha2::{Sha256, Digest};

// ── Batch canonicalization ────────────────────────────────────────────────────

/// A canonically ordered batch of events.
/// Events within a batch are sorted by (shard, seq) — total deterministic order.
#[derive(Clone, Debug)]
pub struct EventBatch {
    pub events: Vec<Event>,
    /// SHA-256(‖ encode_event(eᵢ) for i in sorted order)
    pub batch_root: Hash32,
}

impl EventBatch {
    /// Construct a batch from an unsorted slice — sorts in place, computes root.
    pub fn new(mut events: Vec<Event>) -> Self {
        // Canonical sort: shard ASC, then seq ASC (total order within shard).
        events.sort_by(|a, b| {
            a.shard.0.cmp(&b.shard.0).then(a.seq.cmp(&b.seq))
        });
        let batch_root = Self::compute_root(&events);
        Self { events, batch_root }
    }

    fn compute_root(events: &[Event]) -> Hash32 {
        let mut h = Sha256::new();
        h.update(&(events.len() as u32).to_be_bytes());
        for e in events {
            h.update(&encode_event(e));
        }
        let r = h.finalize();
        let mut out = [0u8; 32]; out.copy_from_slice(&r); Hash32(out)
    }

    /// PO-N1: apply this batch to an initial state deterministically.
    pub fn apply(&self, initial: State) -> Result<State, TrapCode> {
        replay(self.events.clone(), initial)
    }
}

// ── Replay verifier ───────────────────────────────────────────────────────────

/// PO-N1 / PO-B2 verifier: proves two independent replay paths agree.
pub struct ReplayVerifier;

impl ReplayVerifier {
    /// Verify that replaying `events` from `s1` and `s2` (where s1 == s2)
    /// yields identical states.  Returns Err(BatchReplayMismatch) if they differ.
    pub fn verify_determinism(
        events: Vec<Event>,
        s1: State,
        s2: State,
    ) -> Result<State, TrapCode> {
        // Precondition: s1 and s2 must be equal initial states.
        if s1 != s2 { return Err(TrapCode::BatchReplayMismatch); }

        let r1 = replay(events.clone(), s1)?;
        let r2 = replay(events, s2)?;

        if r1 != r2 { return Err(TrapCode::BatchReplayMismatch); }
        Ok(r1)
    }

    /// Verify two independently computed state roots match after the same events.
    pub fn verify_root_agreement(root_a: &Hash32, root_b: &Hash32) -> Result<(), TrapCode> {
        if root_a == root_b { Ok(()) } else { Err(TrapCode::BatchReplayMismatch) }
    }
}

// ── Network envelope ──────────────────────────────────────────────────────────

/// A network-transmitted state snapshot — includes root for integrity check.
#[derive(Clone, Debug)]
pub struct StateSnapshot {
    pub state: State,
    pub claimed_root: Hash32,
}

impl StateSnapshot {
    pub fn new(state: State) -> Self {
        let root = compute_state_root(&state);
        Self { claimed_root: root.clone(), state: { let mut s = state; s.root = root; s } }
    }

    /// Verify the snapshot is internally consistent.
    pub fn verify(&self) -> Result<(), TrapCode> {
        let actual = compute_state_root(&self.state);
        if actual == self.claimed_root { Ok(()) } else { Err(TrapCode::InvalidRoot) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;
    extern crate alloc; use alloc::vec;

    fn make_noop_event(state: &State) -> Event {
        use sha2::{Sha256, Digest};
        let inp = vec![]; let h = Sha256::digest(&inp);
        let mut id = [0u8;32]; id.copy_from_slice(&h);
        Event {
            id: Hash32(id), seq: state.trace.len() as u64 + 1,
            shard: ShardId("s0".into()), actor: Actor("did:i-am:t".into()),
            capability: Capability { scope: vec!["write".into()],
                issuer: Actor("did:i-am:root".into()), subject: Actor("did:i-am:t".into()),
                delegation_depth: 0, parent_hash: Hash32::zero() },
            module: "noop".into(), input: inp, prev_root: state.root.clone(),
            gas_limit: 100_000, semantic_version: 1,
            signature: Signature(vec![0x30,0x44,0x02,0x01]),
        }
    }

    #[test]
    fn po_n1_batch_determinism() {
        let s = State::genesis();
        let e = make_noop_event(&s);
        let batch = EventBatch::new(vec![e]);
        let r1 = batch.apply(State::genesis()).unwrap();
        let r2 = batch.apply(State::genesis()).unwrap();
        assert_eq!(r1, r2);
    }

    #[test]
    fn po_n1_replay_verifier() {
        let events = vec![];
        let result = ReplayVerifier::verify_determinism(
            events, State::genesis(), State::genesis());
        assert!(result.is_ok());
    }

    #[test]
    fn batch_root_stable() {
        let s = State::genesis();
        let e = make_noop_event(&s);
        let b1 = EventBatch::new(vec![e.clone()]);
        let b2 = EventBatch::new(vec![e]);
        assert_eq!(b1.batch_root, b2.batch_root);
    }

    #[test]
    fn snapshot_integrity() {
        let snap = StateSnapshot::new(State::genesis());
        assert_eq!(snap.verify(), Ok(()));
    }

    #[test]
    fn snapshot_tampered_fails() {
        let mut snap = StateSnapshot::new(State::genesis());
        snap.state.version = 99; // tamper
        assert_eq!(snap.verify(), Err(TrapCode::InvalidRoot));
    }

    #[test]
    fn root_agreement_check() {
        let h = Hash32([0xab; 32]);
        assert_eq!(ReplayVerifier::verify_root_agreement(&h, &h), Ok(()));
        assert_eq!(ReplayVerifier::verify_root_agreement(&h, &Hash32::zero()), Err(TrapCode::BatchReplayMismatch));
    }
}