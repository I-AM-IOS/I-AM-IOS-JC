// ─────────────────────────────────────────────────────────────────────────────
// WASM ABI — no_std export surface for browser / edge deployment
//
// Exported functions (callable from JS via WebAssembly):
//   kernel_apply(event_json_ptr, event_json_len) → result_json_ptr (u32)
//   kernel_replay(batch_json_ptr, batch_json_len) → result_json_ptr (u32)
//   kernel_state_root(state_json_ptr, state_json_len) → hash_hex_ptr (u32)
//   kernel_version() → u32   (semantic version of the kernel spec)
//   alloc(size) → ptr (u32)
//   dealloc(ptr, size)
//
// Memory model: caller allocates input, kernel allocates output.
// All JSON is UTF-8; lengths are in bytes.
// ─────────────────────────────────────────────────────────────────────────────

extern crate alloc;
use alloc::{vec::Vec, string::String, format};

use crate::types::{Event, State, KernelResult, TrapCode};
use crate::kernel::transition::delta;
use crate::kernel::encoding::compute_state_root;
use crate::network::EventBatch;

// ── WASM memory allocator ─────────────────────────────────────────────────────
// The kernel uses a bump allocator backed by a static arena when running in
// a WASM sandbox.  In native mode, alloc::vec! is backed by the system allocator.

/// Kernel spec semantic version: 3.2 → 0x00_03_02_00
pub const KERNEL_SPEC_VERSION: u32 = 0x0003_0200;

// ── JSON result envelope ──────────────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
fn result_ok(payload: &str) -> String {
    format!(r#"{{"ok":true,"result":{}}}"#, payload)
}

#[cfg(target_arch = "wasm32")]
fn result_err(code: &TrapCode) -> String {
    format!(r#"{{"ok":false,"error":"{:?}"}}"#, code)
}

// ── Core WASM-exported functions (cfg(target_arch = "wasm32")) ────────────────
#[cfg(target_arch = "wasm32")]
use core::slice;

/// Apply a single event (JSON) to an initial state (JSON).
/// Returns a JSON-encoded KernelResult.
///
/// # Safety
/// Caller must provide valid UTF-8 pointers with the given lengths.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn kernel_apply(
    event_ptr: u32, event_len: u32,
    state_ptr: u32, state_len: u32,
) -> u32 {
    let event_bytes = slice::from_raw_parts(event_ptr as *const u8, event_len as usize);
    let state_bytes = slice::from_raw_parts(state_ptr as *const u8, state_len as usize);

    let out = match (
        serde_json::from_slice::<Event>(event_bytes),
        serde_json::from_slice::<State>(state_bytes),
    ) {
        (Ok(e), Ok(s)) => {
            match delta(e, s) {
                KernelResult::Commit(s2) =>
                    result_ok(&serde_json::to_string(&s2).unwrap_or_default()),
                KernelResult::Revert(c) => result_err(&c),
                KernelResult::Reject(c) => result_err(&c),
            }
        }
        _ => result_err(&TrapCode::InvalidEvent),
    };

    write_result(out)
}

/// Apply a canonically ordered batch of events.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn kernel_replay(
    batch_ptr: u32, batch_len: u32,
    state_ptr: u32, state_len: u32,
) -> u32 {
    let batch_bytes = slice::from_raw_parts(batch_ptr as *const u8, batch_len as usize);
    let state_bytes = slice::from_raw_parts(state_ptr as *const u8, state_len as usize);

    let out = match (
        serde_json::from_slice::<Vec<Event>>(batch_bytes),
        serde_json::from_slice::<State>(state_bytes),
    ) {
        (Ok(events), Ok(initial)) => {
            let batch = EventBatch::new(events);
            match batch.apply(initial) {
                Ok(s)  => result_ok(&serde_json::to_string(&s).unwrap_or_default()),
                Err(c) => result_err(&c),
            }
        }
        _ => result_err(&TrapCode::InvalidEvent),
    };

    write_result(out)
}

/// Compute SHA-256 state root for a JSON-encoded state.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn kernel_state_root(ptr: u32, len: u32) -> u32 {
    let bytes = slice::from_raw_parts(ptr as *const u8, len as usize);
    let out = match serde_json::from_slice::<State>(bytes) {
        Ok(s)  => compute_state_root(&s).to_hex(),
        Err(_) => "error:invalid_state".into(),
    };
    write_result(out)
}

/// Return the kernel spec version as u32.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub extern "C" fn kernel_version() -> u32 { KERNEL_SPEC_VERSION }

/// WASM allocator shim — JS calls this to get a writable buffer for input data.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn wasm_alloc(size: u32) -> u32 {
    let mut v = alloc::vec![0u8; size as usize];
    let ptr = v.as_mut_ptr() as u32;
    core::mem::forget(v);
    ptr
}

/// WASM deallocator shim.
#[cfg(target_arch = "wasm32")]
#[no_mangle]
pub unsafe extern "C" fn wasm_dealloc(ptr: u32, size: u32) {
    let _ = Vec::from_raw_parts(ptr as *mut u8, size as usize, size as usize);
}

// ── Output buffer management ──────────────────────────────────────────────────

/// Write a String into a length-prefixed buffer and return the pointer.
/// Layout: [u32 len BE][utf-8 bytes...]
#[cfg(target_arch = "wasm32")]
fn write_result(s: String) -> u32 {
    let bytes = s.into_bytes();
    let len = bytes.len() as u32;
    let mut buf: Vec<u8> = Vec::with_capacity(4 + bytes.len());
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(&bytes);
    let ptr = buf.as_ptr() as u32;
    core::mem::forget(buf);
    ptr
}

// ── Native (non-WASM) safe wrappers used by integration tests ────────────────

/// Apply a single event to a state — safe wrapper for use in native code/tests.
pub fn apply(event: Event, state: State) -> KernelResult {
    delta(event, state)
}

/// Apply an ordered event batch — safe native wrapper.
pub fn apply_batch(events: Vec<Event>, initial: State) -> Result<State, TrapCode> {
    EventBatch::new(events).apply(initial)
}

/// Compute the hex-encoded state root.
pub fn state_root_hex(state: &State) -> String {
    compute_state_root(state).to_hex()
}

/// Return the kernel spec version string.
pub fn version_string() -> String {
    format!("I-AM-REKERNEL v{}.{}.{}",
        (KERNEL_SPEC_VERSION >> 16) & 0xFF,
        (KERNEL_SPEC_VERSION >>  8) & 0xFF,
         KERNEL_SPEC_VERSION        & 0xFF)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::*;
    extern crate alloc; use alloc::vec;

    #[test]
    fn version_string_correct() {
        let v = version_string();
        assert!(v.contains("3.2"), "version string: {}", v);
    }

    #[test]
    fn apply_wrapper_works() {
        let s = State::genesis();
        let e = Event {
            id: Hash32([0u8;32]), seq: 1, shard: ShardId("s0".into()),
            actor: Actor("did:i-am:t".into()),
            capability: Capability { scope: vec!["write".into()],
                issuer: Actor("did:i-am:root".into()), subject: Actor("did:i-am:t".into()),
                delegation_depth: 0, parent_hash: Hash32::zero() },
            module: "noop".into(), input: vec![],
            prev_root: Hash32::zero(), gas_limit: 100_000,
            semantic_version: 1, signature: Signature(vec![0x30,0x44,0x02,0x01]),
        };
        assert!(matches!(apply(e, s), KernelResult::Commit(_)));
    }

    #[test]
    fn state_root_hex_stable() {
        let s = State::genesis();
        assert_eq!(state_root_hex(&s), state_root_hex(&s));
        assert_eq!(state_root_hex(&s).len(), 64); // 32 bytes hex
    }

    #[test]
    fn apply_batch_empty() {
        let r = apply_batch(vec![], State::genesis());
        assert!(r.is_ok());
    }
}