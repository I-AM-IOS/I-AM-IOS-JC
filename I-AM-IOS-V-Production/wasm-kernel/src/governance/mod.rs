// ─────────────────────────────────────────────────────────────────────────────
// Governance — Constitutional changes, fork registry, quorum enforcement
// PO-G1: Quorum Enforcement — ≥⌈2/3⌉ validators must sign
// PO-G2: Valid Fork Rule   — ancestor must be known + quorum cert valid
// ─────────────────────────────────────────────────────────────────────────────
extern crate alloc;
use alloc::{string::String, vec::Vec, collections::BTreeMap};
use crate::types::{Actor, Hash32, TrapCode};

// ── Quorum math ───────────────────────────────────────────────────────────────

/// Returns the minimum number of signatures required for quorum: ⌈2/3 × n⌉.
pub fn quorum_threshold(n: usize) -> usize {
    (2 * n + 2) / 3   // ceiling division: ⌈2n/3⌉
}

// ── PO-G1: Constitutional change + GovernanceLedger ──────────────────────────

/// A proposed constitutional change, carrying signatures from the validator set.
#[derive(Clone, Debug)]
pub struct ConstitutionalChange {
    pub id:           u32,
    pub description:  String,
    pub proposed_by:  Actor,
    pub anchor_root:  Hash32,
    /// (signer, DER-encoded signature bytes)
    pub signatures:   Vec<(Actor, Vec<u8>)>,
}

/// Append-only ledger of constitutional proposals and their enactment status.
pub struct GovernanceLedger {
    /// Current validator set.
    pub validators: Vec<Actor>,
    /// Pending proposals keyed by id.
    proposals:      BTreeMap<u32, ConstitutionalChange>,
    /// Set of enacted proposal ids.
    enacted:        Vec<u32>,
}

impl GovernanceLedger {
    pub fn new(validators: Vec<Actor>) -> Self {
        Self { validators, proposals: BTreeMap::new(), enacted: Vec::new() }
    }

    /// Submit a proposal for later enactment.
    pub fn propose(&mut self, change: ConstitutionalChange) {
        self.proposals.insert(change.id, change);
    }

    /// PO-G1: Try to enact proposal `id`.
    /// Returns Ok(()) if ≥⌈2/3⌉ validators have signed, else Err(QuorumNotMet).
    pub fn try_enact(&mut self, id: u32) -> Result<(), TrapCode> {
        let proposal = self.proposals.get(&id).ok_or(TrapCode::QuorumNotMet)?;
        let threshold = quorum_threshold(self.validators.len());
        // Count signatures from known validators
        let valid_sigs = proposal.signatures.iter()
            .filter(|(signer, sig)| {
                !sig.is_empty() && self.validators.contains(signer)
            })
            .count();
        if valid_sigs >= threshold {
            self.enacted.push(id);
            Ok(())
        } else {
            Err(TrapCode::QuorumNotMet)
        }
    }

    pub fn is_enacted(&self, id: u32) -> bool { self.enacted.contains(&id) }
}

// ── PO-G2: Fork Registry ──────────────────────────────────────────────────────

/// A proposed chain fork with quorum certificate.
#[derive(Clone, Debug)]
pub struct ForkProposal {
    pub fork_id:     u32,
    /// Ancestor root must be known to this node.
    pub ancestor:    Hash32,
    /// New genesis root after fork.
    pub new_genesis: Hash32,
    /// (signer, sig) quorum cert from validators.
    pub quorum_cert: Vec<(Actor, Vec<u8>)>,
}

/// Registry of known chain roots; accepts forks that have a known ancestor + quorum.
pub struct ForkRegistry {
    /// Set of known (canonical) state roots.
    known_roots: Vec<Hash32>,
}

impl ForkRegistry {
    pub fn new(genesis_root: Hash32) -> Self {
        Self { known_roots: alloc::vec![genesis_root] }
    }

    /// PO-G2: Accept a fork proposal.
    /// Returns Ok(()) if ancestor is known and quorum cert is valid.
    pub fn accept_fork(&mut self, proposal: ForkProposal, validators: &[Actor]) -> Result<(), TrapCode> {
        // Ancestor must be a known root
        if !self.known_roots.contains(&proposal.ancestor) {
            return Err(TrapCode::InvalidFork);
        }
        // Quorum cert must meet threshold
        let threshold = quorum_threshold(validators.len());
        let valid_sigs = proposal.quorum_cert.iter()
            .filter(|(signer, sig)| !sig.is_empty() && validators.contains(signer))
            .count();
        if valid_sigs < threshold {
            return Err(TrapCode::QuorumNotMet);
        }
        // Accept: record new genesis root as known
        self.known_roots.push(proposal.new_genesis.clone());
        Ok(())
    }

    pub fn known_roots(&self) -> &[Hash32] { &self.known_roots }
}

#[cfg(test)]
mod tests {
    use super::*;
    extern crate alloc;
    use alloc::{vec, string::ToString};

    fn actor(s: &str) -> Actor { Actor(s.to_string()) }

    #[test]
    fn quorum_threshold_values() {
        assert_eq!(quorum_threshold(1), 1);
        assert_eq!(quorum_threshold(2), 2);
        assert_eq!(quorum_threshold(3), 2);
        assert_eq!(quorum_threshold(4), 3);
        assert_eq!(quorum_threshold(6), 4);
        assert_eq!(quorum_threshold(9), 6);
    }

    #[test]
    fn po_g1_quorum_not_met() {
        let vals = vec![actor("v1"), actor("v2"), actor("v3")];
        let mut l = GovernanceLedger::new(vals);
        l.propose(ConstitutionalChange {
            id: 1, description: "test".to_string(),
            proposed_by: actor("v1"), anchor_root: Hash32::zero(),
            signatures: vec![(actor("v1"), vec![0x30])], // only 1/3
        });
        assert_eq!(l.try_enact(1), Err(TrapCode::QuorumNotMet));
    }

    #[test]
    fn po_g1_quorum_met() {
        let vals = vec![actor("v1"), actor("v2"), actor("v3")];
        let mut l = GovernanceLedger::new(vals);
        l.propose(ConstitutionalChange {
            id: 2, description: "test".to_string(),
            proposed_by: actor("v1"), anchor_root: Hash32::zero(),
            signatures: vec![(actor("v1"), vec![0x30]), (actor("v2"), vec![0x30])], // 2/3 ✓
        });
        assert_eq!(l.try_enact(2), Ok(()));
        assert!(l.is_enacted(2));
    }

    #[test]
    fn po_g2_unknown_ancestor() {
        let vals = vec![actor("v1"), actor("v2"), actor("v3")];
        let mut r = ForkRegistry::new(Hash32::zero());
        let result = r.accept_fork(ForkProposal {
            fork_id: 1, ancestor: Hash32([0xff;32]),
            new_genesis: Hash32([0x01;32]),
            quorum_cert: vec![(actor("v1"), vec![0x30]), (actor("v2"), vec![0x30])],
        }, &vals);
        assert_eq!(result, Err(TrapCode::InvalidFork));
    }

    #[test]
    fn po_g2_valid_fork() {
        let vals = vec![actor("v1"), actor("v2"), actor("v3")];
        let mut r = ForkRegistry::new(Hash32::zero());
        let result = r.accept_fork(ForkProposal {
            fork_id: 2, ancestor: Hash32::zero(),
            new_genesis: Hash32([0x02;32]),
            quorum_cert: vec![(actor("v1"), vec![0x30]), (actor("v2"), vec![0x30])],
        }, &vals);
        assert_eq!(result, Ok(()));
        assert_eq!(r.known_roots().len(), 2);
    }
}
