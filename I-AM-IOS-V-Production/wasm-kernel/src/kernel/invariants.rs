// §4 Invariant Set Γ — PO-B3 (invariant preservation), PO-T2 (cap non-escalation)
use crate::types::{State, Capability, TrapCode, Z256};

#[derive(Debug, PartialEq, Eq)]
pub enum InvariantResult { Ok, Violated(TrapCode, &'static str) }

pub fn check_invariants(s: &State) -> InvariantResult {
    for bal in s.balance.values() {
        if bal.0 > Z256::MAX.0 {
            return InvariantResult::Violated(TrapCode::Overflow, "balance > Z256::MAX");
        }
    }
    if s.version > 0 && s.root.is_zero() {
        return InvariantResult::Violated(TrapCode::InvalidRoot, "non-genesis state has zero root");
    }
    if s.trace.len() as u64 != s.version {
        return InvariantResult::Violated(TrapCode::InvalidEvent, "trace len != version");
    }
    InvariantResult::Ok
}

pub fn check_capability_non_escalation(child: &Capability, parent: &Capability) -> bool {
    child.scope.iter().all(|p| parent.scope.contains(p))
}

pub fn validate_capability(cap: &Capability, max_depth: u32) -> InvariantResult {
    if cap.delegation_depth > max_depth {
        return InvariantResult::Violated(TrapCode::CapabilityViolation, "depth exceeded");
    }
    if cap.scope.is_empty() {
        return InvariantResult::Violated(TrapCode::CapabilityViolation, "empty scope");
    }
    InvariantResult::Ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{State, Actor, Hash32, EventId};
    extern crate alloc; use alloc::vec;

    #[test] fn genesis_passes() { assert_eq!(check_invariants(&State::genesis()), InvariantResult::Ok); }

    #[test] fn non_escalation() {
        let parent = Capability { scope: vec!["read".into(), "write".into()],
            issuer: Actor("did:i-am:root".into()), subject: Actor("did:i-am:a".into()),
            delegation_depth: 0, parent_hash: Hash32::zero() };
        let ok  = Capability { scope: vec!["read".into()], ..parent.clone() };
        let bad = Capability { scope: vec!["read".into(), "admin".into()], ..parent.clone() };
        assert!(check_capability_non_escalation(&ok, &parent));
        assert!(!check_capability_non_escalation(&bad, &parent));
    }

    #[test] fn zero_root_after_genesis_fails() {
        let mut s = State::genesis();
        s.version = 1; s.trace.push(EventId(Hash32::zero()));
        assert_ne!(check_invariants(&s), InvariantResult::Ok);
    }
}
RUST

cat > /home/claude/rekernel/src/kernel/transition.rs << 'RUST'
// §4 Total Transition Function δ: E × S → KernelResult
// TOTAL — every (e,s) pair has a defined output.  PO-B1, PO-B3.
extern crate alloc;
use alloc::vec::Vec;
use crate::types::*;
use crate::kernel::encoding::*;
use crate::kernel::invariants::{check_invariants, validate_capability, InvariantResult};

pub const B_MAX: u64 = 10_000_000;
pub const MAX_DELEGATION_DEPTH: u32 = 16;

fn verify_sig(e: &Event) -> bool { !e.signature.0.is_empty() && e.signature.0.len() <= 72 }
fn verify_cap(c: &Capability) -> bool { validate_capability(c, MAX_DELEGATION_DEPTH) == InvariantResult::Ok }
fn check_order(e: &Event) -> bool { e.seq > 0 }
fn check_root(e: &Event, s: &State) -> bool { e.prev_root == s.root }

pub fn is_valid(e: &Event, s: &State) -> bool {
    verify_sig(e) && verify_cap(&e.capability) && check_order(e) && check_root(e, s)
}

#[derive(Debug, PartialEq, Eq)]
pub enum ExecResult { Ok(State), Trap(TrapCode) }

fn exec_kv_set(input: &[u8], gas: &mut u64, mut s: State) -> ExecResult {
    *gas = gas.saturating_add(100);
    match decode_kv_input(input) { Some((k,v)) => { s.kv.insert(k,v); ExecResult::Ok(s) } None => ExecResult::Trap(TrapCode::InvalidEvent) }
}
fn exec_kv_delete(input: &[u8], gas: &mut u64, mut s: State) -> ExecResult {
    *gas = gas.saturating_add(50);
    match decode_key_input(input) { Some(k) => { s.kv.remove(&k); ExecResult::Ok(s) } None => ExecResult::Trap(TrapCode::InvalidEvent) }
}
fn exec_balance_transfer(input: &[u8], gas: &mut u64, mut s: State) -> ExecResult {
    *gas = gas.saturating_add(200);
    match decode_transfer_input(input) {
        Some((from, to, amt)) => {
            let fb = s.balance.get(&from).copied().unwrap_or(Z256::ZERO);
            let nf = match fb.checked_sub(Z256(amt)) { Some(v)=>v, None=>return ExecResult::Trap(TrapCode::Overflow) };
            let tb = s.balance.get(&to).copied().unwrap_or(Z256::ZERO);
            let nt = match tb.checked_add(Z256(amt)) { Some(v)=>v, None=>return ExecResult::Trap(TrapCode::Overflow) };
            s.balance.insert(from,nf); s.balance.insert(to,nt); ExecResult::Ok(s)
        }
        None => ExecResult::Trap(TrapCode::InvalidEvent)
    }
}
fn exec_balance_mint(input: &[u8], gas: &mut u64, mut s: State) -> ExecResult {
    *gas = gas.saturating_add(200);
    match decode_mint_input(input) {
        Some((k,amt)) => { let b=s.balance.get(&k).copied().unwrap_or(Z256::ZERO);
            match b.checked_add(Z256(amt)) { Some(nb)=>{ s.balance.insert(k,nb); ExecResult::Ok(s) } None=>ExecResult::Trap(TrapCode::Overflow) } }
        None => ExecResult::Trap(TrapCode::InvalidEvent)
    }
}
fn exec_meta_set(input: &[u8], gas: &mut u64, mut s: State) -> ExecResult {
    *gas = gas.saturating_add(100);
    match decode_kv_input(input) { Some((k,v))=>{ s.meta.insert(k,v); ExecResult::Ok(s) } None=>ExecResult::Trap(TrapCode::InvalidEvent) }
}

fn execute_module(module: &str, input: &[u8], gas: &mut u64, s: State) -> ExecResult {
    match module {
        "kv.set"           => exec_kv_set(input,gas,s),
        "kv.delete"        => exec_kv_delete(input,gas,s),
        "balance.transfer" => exec_balance_transfer(input,gas,s),
        "balance.mint"     => exec_balance_mint(input,gas,s),
        "meta.set"         => exec_meta_set(input,gas,s),
        "noop"             => { *gas=gas.saturating_add(10); ExecResult::Ok(s) }
        _                  => ExecResult::Trap(TrapCode::InvalidImport),
    }
}

pub fn delta(e: Event, s: State) -> KernelResult {
    if !is_valid(&e, &s) { return KernelResult::Reject(TrapCode::InvalidEvent); }
    if e.gas_limit > B_MAX { return KernelResult::Revert(TrapCode::GasExhausted); }
    let eid = EventId(e.id.clone());
    let mut gas: u64 = 0;
    match execute_module(&e.module, &e.input, &mut gas, s.clone()) {
        ExecResult::Trap(c) => KernelResult::Revert(c),
        ExecResult::Ok(mut s2) => {
            if gas > e.gas_limit { return KernelResult::Revert(TrapCode::GasExhausted); }
            s2.trace.push(eid);
            s2.version = s2.version.saturating_add(1);
            s2.block   = s2.block.saturating_add(1);
            let nr = compute_transition_root(&s.root, &e, &s2);
            s2.root = nr;
            match check_invariants(&s2) {
                InvariantResult::Ok           => KernelResult::Commit(s2),
                InvariantResult::Violated(c,_)=> KernelResult::Revert(c),
            }
        }
    }
}

pub fn replay(events: Vec<Event>, initial: State) -> Result<State, TrapCode> {
    let mut s = initial;
    for e in events {
        match delta(e, s.clone()) {
            KernelResult::Commit(s2) => s = s2,
            KernelResult::Revert(c)  => return Err(c),
            KernelResult::Reject(c)  => return Err(c),
        }
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*; use crate::types::*; use crate::kernel::encoding::compute_state_root;
    extern crate alloc; use alloc::vec;

    fn make_event(module: &str, input: Vec<u8>, state: &State) -> Event {
        use sha2::{Sha256, Digest};
        let h = Sha256::digest(&input); let mut id=[0u8;32]; id.copy_from_slice(&h);
        Event { id:Hash32(id), seq:state.trace.len() as u64+1, shard:ShardId("s0".into()),
            actor:Actor("did:i-am:test".into()),
            capability:Capability{scope:vec!["write".into()],issuer:Actor("did:i-am:root".into()),
                subject:Actor("did:i-am:test".into()),delegation_depth:0,parent_hash:Hash32::zero()},
            module:module.into(), input, prev_root:state.root.clone(),
            gas_limit:1_000_000, semantic_version:1, signature:Signature(vec![0x30,0x44,0x02,0x01]) }
    }
    fn kv_inp(k:&str,v:&str)->Vec<u8>{
        let mut b=Vec::new(); b.extend_from_slice(&(k.len() as u32).to_be_bytes());
        b.extend_from_slice(k.as_bytes()); b.extend_from_slice(&(v.len() as u32).to_be_bytes());
        b.extend_from_slice(v.as_bytes()); b }

    #[test] fn deterministic() {
        let s=State::genesis(); let inp=kv_inp("hello","world");
        assert_eq!(delta(make_event("kv.set",inp.clone(),&s),s.clone()),
                   delta(make_event("kv.set",inp,&s),s)); }

    #[test] fn reject_wrong_root() {
        let s=State::genesis(); let mut e=make_event("kv.set",kv_inp("x","y"),&s);
        e.prev_root=Hash32([0xff;32]);
        assert!(matches!(delta(e,s), KernelResult::Reject(TrapCode::InvalidEvent))); }

    #[test] fn overflow_reverts() {
        let mut s=State::genesis(); s.balance.insert("a".into(),Z256(u64::MAX));
        s.root=compute_state_root(&s);
        let mut inp=Vec::new();
        inp.extend_from_slice(&1u32.to_be_bytes()); inp.push(b'a');
        inp.extend_from_slice(&1u32.to_be_bytes()); inp.push(b'a');
        inp.extend_from_slice(&1u64.to_be_bytes());
        assert!(matches!(delta(make_event("balance.transfer",inp,&s),s), KernelResult::Revert(TrapCode::Overflow))); }

    #[test] fn unknown_module() {
        let s=State::genesis();
        assert!(matches!(delta(make_event("bad.fn",vec![],&s),s), KernelResult::Revert(TrapCode::InvalidImport))); }

    #[test] fn kv_commit() {
        let s=State::genesis(); let e=make_event("kv.set",kv_inp("foo","bar"),&s);
        match delta(e,s) { KernelResult::Commit(s2) => { assert_eq!(s2.kv.get("foo"),Some(&b"bar".to_vec())); assert_eq!(s2.version,1); } other=>panic!("{:?}",other) } }

    #[test] fn replay_empty() {
        assert_eq!(replay(vec![],State::genesis()), replay(vec![],State::genesis())); }
}
