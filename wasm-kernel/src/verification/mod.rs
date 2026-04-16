// Verification module — 13 PO test harnesses (test-only content)
// See individual #[test] functions below.
#[cfg(test)]
mod tests {
    extern crate alloc;
    use alloc::{vec, vec::Vec, string::ToString};
    use sha2::{Sha256, Digest};

    use crate::types::*;
    use crate::kernel::transition::{delta, replay, B_MAX};
    use crate::kernel::invariants::{check_invariants, check_capability_non_escalation, InvariantResult};
    use crate::kernel::encoding::compute_state_root;
    use crate::boundary::{NullAdapter, BdeAdapter, Sha256Provider, CryptoProvider};
    use crate::governance::{GovernanceLedger, ConstitutionalChange, ForkRegistry, ForkProposal, quorum_threshold};
    use crate::emergency::{SunsetPolicy, ProofDebtLedger};
    use crate::network::{EventBatch, ReplayVerifier, StateSnapshot};

    fn actor(s: &str) -> Actor { Actor(s.to_string()) }

    fn make_event(module: &str, input: Vec<u8>, state: &State) -> Event {
        let h = Sha256::digest(&input); let mut id=[0u8;32]; id.copy_from_slice(&h);
        Event { id:Hash32(id), seq:state.trace.len() as u64+1, shard:ShardId("s0".into()),
            actor:actor("did:i-am:test"),
            capability:Capability{scope:vec!["write".into()],
                issuer:actor("did:i-am:root"),subject:actor("did:i-am:test"),
                delegation_depth:0,parent_hash:Hash32::zero()},
            module:module.into(), input, prev_root:state.root.clone(),
            gas_limit:1_000_000, semantic_version:1,
            signature:Signature(vec![0x30,0x44,0x02,0x01]) }
    }

    fn kv_inp(k:&str,v:&str)->Vec<u8>{
        let mut b=Vec::new();
        b.extend_from_slice(&(k.len() as u32).to_be_bytes()); b.extend_from_slice(k.as_bytes());
        b.extend_from_slice(&(v.len() as u32).to_be_bytes()); b.extend_from_slice(v.as_bytes()); b }

    fn mint_inp(k:&str,amt:u64)->Vec<u8>{
        let mut b=Vec::new();
        b.extend_from_slice(&(k.len() as u32).to_be_bytes()); b.extend_from_slice(k.as_bytes());
        b.extend_from_slice(&amt.to_be_bytes()); b }

    // PO-B1: Determinism — TLA+: □[δ(e,s) = δ(e,s)]_vars
    #[test]
    fn po_b1_determinism() {
        let s=State::genesis(); let inp=kv_inp("hello","world");
        assert_eq!(delta(make_event("kv.set",inp.clone(),&s),s.clone()),
                   delta(make_event("kv.set",inp,&s),s)); }

    // PO-B2: Replay Equality
    #[test]
    fn po_b2_replay_equality() {
        let e=make_event("noop",vec![],&State::genesis());
        assert_eq!(replay(vec![e.clone()],State::genesis()),
                   replay(vec![e],State::genesis())); }

    // PO-B3: Invariant Preservation — Coq: Γ(s) ∧ Commit(s') → Γ(s')
    #[test]
    fn po_b3_invariant_preservation() {
        let s=State::genesis();
        assert_eq!(check_invariants(&s),InvariantResult::Ok);
        match delta(make_event("kv.set",kv_inp("k","v"),&s),s) {
            KernelResult::Commit(s2)=>assert_eq!(check_invariants(&s2),InvariantResult::Ok),
            other=>panic!("{:?}",other) } }

    // PO-B4: Crypto Provider Parity
    #[test]
    fn po_b4_crypto_parity() {
        let p=Sha256Provider;
        assert_eq!(p.sha256(b"IAM"),p.sha256(b"IAM"));
        assert_ne!(p.sha256(b"IAM"),p.sha256(b"OTHER")); }

    // PO-T2: Capability Non-Escalation — Coq: scope(child) ⊆ scope(parent)
    #[test]
    fn po_t2_non_escalation() {
        let par=Capability{scope:vec!["read".into(),"write".into()],
            issuer:actor("did:i-am:root"),subject:actor("did:i-am:a"),
            delegation_depth:0,parent_hash:Hash32::zero()};
        let ok =Capability{scope:vec!["read".into()],..par.clone()};
        let bad=Capability{scope:vec!["read".into(),"admin".into()],..par.clone()};
        assert!( check_capability_non_escalation(&ok,&par));
        assert!(!check_capability_non_escalation(&bad,&par)); }

    // PO-G1: Quorum Enforcement
    #[test]
    fn po_g1_quorum() {
        let vals=vec![actor("v1"),actor("v2"),actor("v3")];
        let mut l=GovernanceLedger::new(vals.clone());
        l.propose(ConstitutionalChange{id:1,description:"t".into(),
            proposed_by:actor("v1"),anchor_root:Hash32::zero(),
            signatures:vec![(actor("v1"),vec![0x30])]});
        assert_eq!(l.try_enact(1),Err(TrapCode::QuorumNotMet));
        l.propose(ConstitutionalChange{id:2,description:"t".into(),
            proposed_by:actor("v1"),anchor_root:Hash32::zero(),
            signatures:vec![(actor("v1"),vec![0x30]),(actor("v2"),vec![0x30])]});
        assert_eq!(l.try_enact(2),Ok(())); }

    // PO-G2: Valid Fork Rule
    #[test]
    fn po_g2_fork() {
        let vals=vec![actor("v1"),actor("v2"),actor("v3")];
        let mut r=ForkRegistry::new(Hash32::zero());
        assert_eq!(r.accept_fork(ForkProposal{fork_id:1,ancestor:Hash32([0xff;32]),
            new_genesis:Hash32([0x01;32]),
            quorum_cert:vec![(actor("v1"),vec![0x30]),(actor("v2"),vec![0x30])]},&vals),
            Err(TrapCode::InvalidFork));
        assert_eq!(r.accept_fork(ForkProposal{fork_id:2,ancestor:Hash32::zero(),
            new_genesis:Hash32([0x02;32]),
            quorum_cert:vec![(actor("v1"),vec![0x30]),(actor("v2"),vec![0x30])]},&vals),Ok(())); }

    // PO-E1: Sunset Enforcement
    #[test]
    fn po_e1_sunset() {
        let p=SunsetPolicy::new(500);
        assert_eq!(p.check(499),Ok(()));
        assert_eq!(p.check(500),Err(TrapCode::SunsetExpired)); }

    // PO-E2: Proof Debt
    #[test]
    fn po_e2_proof_debt() {
        let mut l=ProofDebtLedger::new(13);
        assert_eq!(l.check(),Err(TrapCode::ProofDebtExceeded));
        l.resolve(13);
        assert_eq!(l.check(),Ok(()));
        assert!(l.all_closed()); }

    // PO-N1: Batch Replay Determinism
    #[test]
    fn po_n1_batch_determinism() {
        let s=State::genesis(); let e=make_event("noop",vec![],&s);
        let b=EventBatch::new(vec![e]);
        assert_eq!(b.apply(State::genesis()),b.apply(State::genesis())); }

    // PO-C1: Root Commitment — root changes iff state changes
    #[test]
    fn po_c1_root_commitment() {
        let s=State::genesis(); let r0=compute_state_root(&s);
        match delta(make_event("kv.set",kv_inp("x","y"),&s),s) {
            KernelResult::Commit(s2)=>assert_ne!(r0,compute_state_root(&s2)),
            other=>panic!("{:?}",other) } }

    // PO-C2: Trace Append-Only — Lean: |trace(s')| = |trace(s)| + 1
    #[test]
    fn po_c2_trace_append_only() {
        let s0=State::genesis();
        match delta(make_event("noop",vec![],&s0),s0) {
            KernelResult::Commit(s1)=>{
                assert_eq!(s1.trace.len(),1);
                match delta(make_event("noop",vec![],&s1),s1.clone()) {
                    KernelResult::Commit(s2)=>{ assert_eq!(s2.trace.len(),2);
                        assert!(s2.trace.len()>=s1.trace.len()); }
                    other=>panic!("{:?}",other) } }
            other=>panic!("{:?}",other) } }

    // PO-S1: Total Transition — δ defined for ALL (e,s)
    #[test]
    fn po_s1_total_transition() {
        let s=State::genesis();
        assert!(matches!(delta(make_event("noop",vec![],&s),s.clone()), KernelResult::Commit(_)));
        let mut e_bad=make_event("noop",vec![],&s); e_bad.prev_root=Hash32([0xde;32]);
        assert!(matches!(delta(e_bad,s.clone()), KernelResult::Reject(_)));
        assert!(matches!(delta(make_event("bad.syscall",vec![],&s),s.clone()),
            KernelResult::Revert(TrapCode::InvalidImport)));
        let mut e_gas=make_event("noop",vec![],&s); e_gas.gas_limit=B_MAX+1;
        assert!(matches!(delta(e_gas,s.clone()), KernelResult::Revert(TrapCode::GasExhausted)));
    }

    // Integration: mint → transfer → snapshot verify
    #[test]
    fn integration_full() {
        let s0=State::genesis();
        let e1=make_event("balance.mint",mint_inp("alice",1000),&s0);
        let s1=match delta(e1,s0){KernelResult::Commit(s)=>s,o=>panic!("{:?}",o)};
        assert_eq!(s1.balance.get("alice"),Some(&Z256(1000)));
        let mut xfer=Vec::new();
        xfer.extend_from_slice(&5u32.to_be_bytes()); xfer.extend_from_slice(b"alice");
        xfer.extend_from_slice(&3u32.to_be_bytes()); xfer.extend_from_slice(b"bob");
        xfer.extend_from_slice(&400u64.to_be_bytes());
        let e2=make_event("balance.transfer",xfer,&s1);
        let s2=match delta(e2,s1){KernelResult::Commit(s)=>s,o=>panic!("{:?}",o)};
        assert_eq!(s2.balance.get("alice"),Some(&Z256(600)));
        assert_eq!(s2.balance.get("bob"),  Some(&Z256(400)));
        assert_eq!(s2.version,2);
        assert_eq!(StateSnapshot::new(s2).verify(),Ok(()));
    }
}