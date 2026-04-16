// ─────────────────────────────────────────────────────────────────────────────
// §2.3 Canonical Encoding
// Rules: UTF-8 NFKC strings · sorted keys (BTreeMap) · fixed-width integers
//        (big-endian) · length-prefixed bytes · no omitted fields.
// ─────────────────────────────────────────────────────────────────────────────

extern crate alloc;
use alloc::{vec::Vec, collections::BTreeMap, string::String};
use sha2::{Sha256, Digest};
use crate::types::{Hash32, State, Event};

// ── Primitives ────────────────────────────────────────────────────────────────

#[inline]
pub fn encode_u64(v: u64) -> [u8; 8] { v.to_be_bytes() }

#[inline]
pub fn encode_u32(v: u32) -> [u8; 4] { v.to_be_bytes() }

/// 4-byte big-endian length prefix then payload.
pub fn encode_bytes(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + b.len());
    out.extend_from_slice(&(b.len() as u32).to_be_bytes());
    out.extend_from_slice(b);
    out
}

pub fn encode_string(s: &str) -> Vec<u8> { encode_bytes(s.as_bytes()) }

// ── Compound encoders ─────────────────────────────────────────────────────────

/// Encode BTreeMap<String, Vec<u8>> — keys already sorted by BTreeMap.
pub fn encode_kv_map(map: &BTreeMap<String, Vec<u8>>) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&encode_u32(map.len() as u32));
    for (k, v) in map.iter() {
        out.extend(encode_string(k));
        out.extend(encode_bytes(v));
    }
    out
}

/// Deterministic total encoding of State — no omitted fields.
pub fn encode_state(s: &State) -> Vec<u8> {
    let mut buf = Vec::new();

    // KV
    buf.extend(encode_kv_map(&s.kv));

    // Balances (account → u64 big-endian)
    buf.extend_from_slice(&encode_u32(s.balance.len() as u32));
    for (k, v) in s.balance.iter() {
        buf.extend(encode_string(k));
        buf.extend_from_slice(&encode_u64(v.0));
    }

    // Meta
    buf.extend(encode_kv_map(&s.meta));

    // Trace (list of 32-byte event IDs)
    buf.extend_from_slice(&encode_u32(s.trace.len() as u32));
    for ev_id in &s.trace {
        buf.extend_from_slice(&ev_id.0.0);
    }

    // Root (32 bytes fixed)
    buf.extend_from_slice(&s.root.0);

    // Version + block
    buf.extend_from_slice(&encode_u64(s.version));
    buf.extend_from_slice(&encode_u64(s.block));

    buf
}

/// Deterministic event encoding for hash input.
pub fn encode_event(e: &Event) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&e.id.0);
    buf.extend_from_slice(&encode_u64(e.seq));
    buf.extend(encode_string(&e.shard.0));
    buf.extend(encode_string(&e.actor.0));
    buf.extend(encode_string(&e.module));
    buf.extend(encode_bytes(&e.input));
    buf.extend_from_slice(&e.prev_root.0);
    buf.extend_from_slice(&encode_u64(e.gas_limit));
    buf.extend_from_slice(&encode_u32(e.semantic_version));
    buf
}

// ── Hash functions ────────────────────────────────────────────────────────────

/// SHA-256(canonical_state_encoding).
pub fn compute_state_root(s: &State) -> Hash32 {
    let encoded = encode_state(s);
    let hash = Sha256::digest(&encoded);
    let mut out = [0u8; 32];
    out.copy_from_slice(&hash);
    Hash32(out)
}

/// Transition root: SHA-256(prev_root ‖ encode_event(e) ‖ new_state_root).
pub fn compute_transition_root(prev: &Hash32, e: &Event, next: &State) -> Hash32 {
    let mut h = Sha256::new();
    h.update(&prev.0);
    h.update(&encode_event(e));
    h.update(&compute_state_root(next).0);
    let r = h.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&r);
    Hash32(out)
}

// ── Input decoders (used by transition handlers) ──────────────────────────────

pub fn decode_kv_input(input: &[u8]) -> Option<(alloc::string::String, Vec<u8>)> {
    if input.len() < 4 { return None; }
    let klen = u32::from_be_bytes(input[0..4].try_into().ok()?) as usize;
    if input.len() < 4 + klen + 4 { return None; }
    let key = core::str::from_utf8(&input[4..4+klen]).ok()?.to_string();
    let vstart = 4 + klen;
    let vlen = u32::from_be_bytes(input[vstart..vstart+4].try_into().ok()?) as usize;
    if input.len() < vstart + 4 + vlen { return None; }
    let val = input[vstart+4..vstart+4+vlen].to_vec();
    Some((key, val))
}

pub fn decode_key_input(input: &[u8]) -> Option<alloc::string::String> {
    if input.len() < 4 { return None; }
    let klen = u32::from_be_bytes(input[0..4].try_into().ok()?) as usize;
    if input.len() < 4 + klen { return None; }
    core::str::from_utf8(&input[4..4+klen]).ok().map(|s| s.to_string())
}

pub fn decode_transfer_input(input: &[u8]) -> Option<(alloc::string::String, alloc::string::String, u64)> {
    if input.len() < 4 { return None; }
    let flen = u32::from_be_bytes(input[0..4].try_into().ok()?) as usize;
    if input.len() < 4 + flen + 4 { return None; }
    let from = core::str::from_utf8(&input[4..4+flen]).ok()?.to_string();
    let ts = 4 + flen;
    let tlen = u32::from_be_bytes(input[ts..ts+4].try_into().ok()?) as usize;
    if input.len() < ts + 4 + tlen + 8 { return None; }
    let to = core::str::from_utf8(&input[ts+4..ts+4+tlen]).ok()?.to_string();
    let as_ = ts + 4 + tlen;
    let amount = u64::from_be_bytes(input[as_..as_+8].try_into().ok()?);
    Some((from, to, amount))
}

pub fn decode_mint_input(input: &[u8]) -> Option<(alloc::string::String, u64)> {
    if input.len() < 4 { return None; }
    let klen = u32::from_be_bytes(input[0..4].try_into().ok()?) as usize;
    if input.len() < 4 + klen + 8 { return None; }
    let key = core::str::from_utf8(&input[4..4+klen]).ok()?.to_string();
    let amount = u64::from_be_bytes(input[4+klen..4+klen+8].try_into().ok()?);
    Some((key, amount))
}