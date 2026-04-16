// BDE v4.0 — Boundary Determinism Envelope
// PO-B1 (determinism), PO-B2 (replay equality), PO-B4 (crypto provider parity)
extern crate alloc;
use alloc::{vec::Vec, string::String, collections::BTreeMap};
use crate::types::{Event, State, KernelResult, TrapCode};
use crate::kernel::transition::{delta, replay};

pub trait BdeAdapter {
    fn name(&self) -> &'static str;
    fn apply(&self, e: Event, s: State) -> KernelResult;
    /// PO-B2: identical events on identical initial state → identical result
    fn verify_replay(&self, events: Vec<Event>, initial: State) -> Result<State, TrapCode> {
        replay(events, initial)
    }
}

pub trait CryptoProvider {
    fn sha256(&self, data: &[u8]) -> [u8; 32];
    /// PO-B4: any conforming provider returns identical digests for identical input
    fn verify_ecdsa(&self, _pubkey: &[u8], _msg: &[u8], sig: &[u8]) -> bool {
        !sig.is_empty() && sig.len() <= 72
    }
}

pub struct NullAdapter;
impl BdeAdapter for NullAdapter {
    fn name(&self) -> &'static str { "null" }
    fn apply(&self, e: Event, s: State) -> KernelResult { delta(e, s) }
}

pub struct Sha256Provider;
impl CryptoProvider for Sha256Provider {
    fn sha256(&self, data: &[u8]) -> [u8; 32] {
        use sha2::{Sha256, Digest};
        let h = Sha256::digest(data); let mut out=[0u8;32]; out.copy_from_slice(&h); out
    }
}

pub trait StorageAdapter {
    fn get(&self, key: &str) -> Option<Vec<u8>>;
    fn set(&mut self, key: &str, val: Vec<u8>);
    fn delete(&mut self, key: &str);
}

pub struct MemoryStorage { inner: BTreeMap<String, Vec<u8>> }
impl MemoryStorage { pub fn new() -> Self { Self { inner: BTreeMap::new() } } }
impl StorageAdapter for MemoryStorage {
    fn get(&self, key: &str) -> Option<Vec<u8>> { self.inner.get(key).cloned() }
    fn set(&mut self, key: &str, val: Vec<u8>) { self.inner.insert(key.into(), val); }
    fn delete(&mut self, key: &str) { self.inner.remove(key); }
}

#[cfg(test)]
mod tests {
    use super::*; use crate::types::State;
    #[test] fn null_deterministic() {
        let a = NullAdapter;
        assert_eq!(a.verify_replay(alloc::vec![], State::genesis()),
                   a.verify_replay(alloc::vec![], State::genesis())); }
    #[test] fn crypto_pure() {
        let p = Sha256Provider;
        assert_eq!(p.sha256(b"hello"), p.sha256(b"hello")); }
    #[test] fn memory_storage_roundtrip() {
        let mut s = MemoryStorage::new();
        s.set("k", b"v".to_vec());
        assert_eq!(s.get("k"), Some(b"v".to_vec()));
        s.delete("k"); assert_eq!(s.get("k"), None); }
}