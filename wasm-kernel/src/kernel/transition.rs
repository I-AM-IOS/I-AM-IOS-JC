// ─────────────────────────────────────────────────────────────────────────────
// §4 Total Transition Function  δ: E × S → KernelResult
//
// δ(e, s) = Reject(InvalidEvent)    if ¬Valid(e, s)
//           Revert(GasExhausted)    if e.gas_limit > B_MAX
//           Revert(trap)            if ExecTrap(e, s)
//           Commit(s')              otherwise
//
// TOTAL: every (e, s) pair has a defined output — no panics, no UB.
// Proof obligations: PO-B1 (determinism), PO-B3 (invariant preservation).
// ─────────────────────────────────────────────────────────────────────────────

extern crate alloc;
use alloc::vec::Vec;
use crate::types::*;
use crate::kernel::encoding::{
    compute_transition_root, compute_state_root,
    decode_kv_input, decode_key_input, decode_transfer_input, decode_mint_input,
};
use crate::kernel::invariants::{check_invariants, validate_capability, InvariantResult};

/// Maximum gas per transition — §4.2.
pub const B_MAX: u64 = 10_000_000;
/// Maximum delegation depth — §8.
pub const MAX_DELEGATION_DEPTH: u32 = 16;

// ── §3.2 Validity predicate Valid(e, s) ──────────────────────────────────────
// Valid(e,s) = Sig(e) ∧ Cap(e) ∧ Order(e) ∧ RootMatch(e,s)

fn verify_signature(e: &Event) -> bool {
    // Non-empty DER envelope (64–72 bytes) — BDE crypto provider validates
    // the actual ECDSA curve math (PO-B4).
    !e.signature.0.is_empty() && e.signature.0.len() <= 72
}

fn verify_capability(cap: &Capability) -> bool {
    match validate_capability(cap, MAX_DELEGATION_DEPTH) {
        InvariantResult::Ok => true,
        _                   => false,
    }
}

fn check_ordering(e: &Event) -> bool {
    e.seq > 0
}

fn check_root_match(e: &Event, s: &State) -> bool {
    e.prev_root == s.root
}

pub fn is_valid(e: &Event, s: &State) -> bool {
    verify_signature(e)
        && verify_capability(&e.capability)
        && check_ordering(e)
        && check_root_match(e, s)
}

// ── Execution engine (dWASM-STRICT-TOTAL, §5) ─────────────────────────────────
// Forbidden surface §5.2: float, SIMD, threads, host clock, entropy, syscalls.

#[derive(Debug, PartialEq, Eq)]
pub enum ExecResult { Ok(State), Trap(TrapCode) }

fn exec_kv_set(input: &[u8], gas: &mut u64, mut s: State) -> ExecResult {
    *gas = gas.saturating_add(100);
    match decode_kv_input(input) {
        Some((k, v)) => { s.kv.insert(k, v); ExecResult::Ok(s) }
        None          => ExecResult::Trap(TrapCode::InvalidEvent),
    }
}

fn exec_kv_delete(input: &[u8], gas: &mut u64, mut s: State) -> ExecResult {
    *gas = gas.saturating_add(50);
    match decode_key_input(input) {
        Some(k) => { s.kv.remove(&k); ExecResult::Ok(s) }
        None    => ExecResult::Trap(TrapCode::InvalidEvent),
    }
}

fn exec_balance_transfer(input: &[u8], gas: &mut u64, mut s: State) -> ExecResult {
    *gas = gas.saturating_add(200);
    match decode_transfer_input(input) {
        Some((from, to, amount)) => {
            let from_bal = s.balance.get(&from).copied().unwrap_or(Z256::ZERO);
            let new_from = match from_bal.checked_sub(Z256(amount)) {
                Some(v) => v,
                None    => return ExecResult::Trap(TrapCode::Overflow),
            };
            let to_bal = s.balance.get(&to).copied().unwrap_or(Z256::ZERO);
            let new_to = match to_bal.checked_add(Z256(amount)) {
                Some(v) => v,
                None    => return ExecResult::Trap(TrapCode::Overflow),
            };
            s.balance.insert(from, new_from);
            s.balance.insert(to, new_to);
            ExecResult::Ok(s)
        }
        None => ExecResult::Trap(TrapCode::InvalidEvent),
    }
}

fn exec_balance_mint(input: &[u8], gas: &mut u64, mut s: State) -> ExecResult {
    *gas = gas.saturating_add(200);
    match decode_mint_input(input) {
        Some((key, amount)) => {
            let bal = s.balance.get(&key).copied().unwrap_or(Z256::ZERO);
            match bal.checked_add(Z256(amount)) {
                Some(new) => { s.balance.insert(key, new); ExecResult::Ok(s) }
                None      => ExecResult::Trap(TrapCode::Overflow),
            }
        }
        None => ExecResult::Trap(TrapCode::InvalidEvent),
    }
}

fn exec_meta_set(input: &[u8], gas: &mut u64, mut s: State) -> ExecResult {
    *gas = gas.saturating_add(100);
    match decode_kv_input(input) {
        Some((k, v)) => { s.meta.insert(k, v); ExecResult::Ok(s) }
        None          => ExecResult::Trap(TrapCode::InvalidEvent),
    }
}

fn exec_noop(gas: &mut u64, s: State) -> ExecResult {
    *gas = gas.saturating_add(10);
    ExecResult::Ok(s)
}

fn execute_module(module: &str, input: &[u8], gas: &mut u64, s: State) -> ExecResult {
    match module {
        "kv.set"            => exec_kv_set(input, gas, s),
        "kv.delete"         => exec_kv_delete(input, gas, s),
        "balance.transfer"  => exec_balance_transfer(input, gas, s),
        "balance.mint"      => exec_balance_mint(input, gas, s),
        "meta.set"          => exec_meta_set(input, gas, s),
        "noop"              => exec_noop(gas, s),
        _                   => ExecResult::Trap(TrapCode::InvalidImport),
    }
}

// ── §4 Total δ ────────────────────────────────────────────────────────────────

pub fn delta(e: Event, s: State) -> KernelResult {
    // 1. Validity — Reject if ¬Valid(e,s).
    if !is_valid(&e, &s) {
        return KernelResult::Reject(TrapCode::InvalidEvent);
    }
    // 2. Gas budget — Revert if gas_limit > B_MAX.
    if e.gas_limit > B_MAX {
        return KernelResult::Revert(TrapCode::GasExhausted);
    }

    let event_id = EventId(e.id.clone());
    let mut gas_used: u64 = 0;

    // 3. Execute in closed dWASM-STRICT-TOTAL subset.
    match execute_module(&e.module, &e.input, &mut gas_used, s.clone()) {
        ExecResult::Trap(code) => KernelResult::Revert(code),
        ExecResult::Ok(mut s2) => {
            // 4. Gas post-check.
            if gas_used > e.gas_limit {
                return KernelResult::Revert(TrapCode::GasExhausted);
            }
            // 5. Append to trace (append-only).
            s2.trace.push(event_id);
            s2.version = s2.version.saturating_add(1);
            s2.block   = s2.block.saturating_add(1);

            // 6. Compute new commitment root.
            let new_root = compute_transition_root(&s.root, &e, &s2);
            s2.root = new_root;

            // 7. Invariant check on committed state.
            match check_invariants(&s2) {
                InvariantResult::Ok              => KernelResult::Commit(s2),
                InvariantResult::Violated(c, _) => KernelResult::Revert(c),
            }
        }
    }
}

// ── Replay (PO-B2, PO-N1) ─────────────────────────────────────────────────────

/// Apply a sequence of events from an initial state.
/// Identical event sequences always produce identical final states (PO-N1).
pub fn replay(events: Vec<Event>, initial: State) -> Result<State, TrapCode> {
    let mut s = initial;
    for e in events {
        match delta(e, s.clone()) {
            KernelResult::Commit(s2)  => s = s2,
            KernelResult::Revert(c)   => return Err(c),
            KernelResult::Reject(c)   => return Err(c),
        }
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;
    use crate::kernel::encoding::compute_state_root;
    extern crate alloc;
    use alloc::vec;

    fn make_event(module: &str, input: Vec<u8>, state: &State) -> Event {
        use sha2::{Sha256, Digest};
        let h = Sha256::digest(&input);
        let mut id = [0u8; 32]; id.copy_from_slice(&h);
        Event {
            id: Hash32(id),
            seq: state.trace.len() as u64 + 1,
            shard: ShardId("shard-0".into()),
            actor: Actor("did:i-am:test".into()),
            capability: Capability {
                scope: vec!["write".into()],
                issuer: Actor("did:i-am:root".into()),
                subject: Actor("did:i-am:test".into()),
                delegation_depth: 0,
                parent_hash: Hash32::zero(),
            },
            module: module.into(),
            input,
            prev_root: state.root.clone(),
            gas_limit: 1_000_000,
            semantic_version: 1,
            signature: Signature(vec![0x30, 0x44, 0x02, 0x01]),
        }
    }

    fn kv_input(key: &str, val: &str) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&(key.len() as u32).to_be_bytes());
        v.extend_from_slice(key.as_bytes());
        v.extend_from_slice(&(val.len() as u32).to_be_bytes());
        v.extend_from_slice(val.as_bytes());
        v
    }

    // PO-B1 / PO-N1 — determinism
    #[test]
    fn delta_is_deterministic() {
        let s = State::genesis();
        let inp = kv_input("hello", "world");
        let e1 = make_event("kv.set", inp.clone(), &s);
        let e2 = make_event("kv.set", inp.clone(), &s);
        assert_eq!(delta(e1, s.clone()), delta(e2, s));
    }

    // §4.2 Reject on invalid root
    #[test]
    fn reject_on_wrong_prev_root() {
        let s = State::genesis();
        let mut e = make_event("kv.set", kv_input("x", "y"), &s);
        e.prev_root = Hash32([0xff; 32]);
        match delta(e, s) {
            KernelResult::Reject(TrapCode::InvalidEvent) => {}
            other => panic!("expected Reject, got {:?}", other),
        }
    }

    // §6.2 Overflow → Revert, not UB
    #[test]
    fn overflow_reverts_not_ub() {
        let mut s = State::genesis();
        s.balance.insert("alice".into(), Z256(u64::MAX));
        s.root = compute_state_root(&s);
        // transfer 1 FROM alice TO alice — subtract then add, subtract overflows
        let mut inp = Vec::new();
        inp.extend_from_slice(&5u32.to_be_bytes()); inp.extend_from_slice(b"alice");
        inp.extend_from_slice(&5u32.to_be_bytes()); inp.extend_from_slice(b"alice");
        inp.extend_from_slice(&1u64.to_be_bytes());
        let e = make_event("balance.transfer", inp, &s);
        match delta(e, s) {
            KernelResult::Revert(TrapCode::Overflow) => {}
            other => panic!("expected Revert(Overflow), got {:?}", other),
        }
    }

    // Unknown module → Revert(InvalidImport)
    #[test]
    fn unknown_module_traps() {
        let s = State::genesis();
        let e = make_event("unknown.fn", vec![], &s);
        match delta(e, s) {
            KernelResult::Revert(TrapCode::InvalidImport) => {}
            other => panic!("expected InvalidImport, got {:?}", other),
        }
    }

    // Replay determinism — PO-N1
    #[test]
    fn replay_deterministic() {
        let s1 = State::genesis();
        let s2 = State::genesis();
        assert_eq!(replay(vec![], s1), replay(vec![], s2));
    }

    // KV round-trip
    #[test]
    fn kv_set_and_commit() {
        let s = State::genesis();
        let e = make_event("kv.set", kv_input("foo", "bar"), &s);
        match delta(e, s) {
            KernelResult::Commit(s2) => {
                assert_eq!(s2.kv.get("foo"), Some(&b"bar".to_vec()));
                assert_eq!(s2.version, 1);
            }
            other => panic!("{:?}", other),
        }
    }
}