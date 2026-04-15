// ─────────────────────────────────────────────────────────────────────────────
// Emergency Constraints
// PO-E1: Sunset Enforcement — after the sunset block height the kernel must
//         reject all new events (system halts gracefully, not panics).
// PO-E2: Proof Debt — if the number of unverified proof obligations exceeds
//         MAX_PROOF_DEBT the kernel enters read-only mode.
// ─────────────────────────────────────────────────────────────────────────────
use crate::types::TrapCode;

/// Maximum number of unresolved proof obligations before read-only lockout.
pub const MAX_PROOF_DEBT: u32 = 13; // one per formal PO

// ── PO-E1: Sunset ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct SunsetPolicy {
    /// Block height after which the kernel is permanently halted.
    pub sunset_block: u64,
}

impl SunsetPolicy {
    pub fn new(sunset_block: u64) -> Self { Self { sunset_block } }

    /// PO-E1: Returns Err(SunsetExpired) if current_block >= sunset_block.
    pub fn check(&self, current_block: u64) -> Result<(), TrapCode> {
        if current_block >= self.sunset_block {
            Err(TrapCode::SunsetExpired)
        } else {
            Ok(())
        }
    }

    pub fn is_expired(&self, current_block: u64) -> bool {
        current_block >= self.sunset_block
    }
}

// ── PO-E2: Proof Debt ─────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct ProofDebtLedger {
    /// Number of proof obligations not yet machine-checked.
    pub unresolved: u32,
    /// Total POs declared.
    pub total: u32,
}

impl ProofDebtLedger {
    pub fn new(total: u32) -> Self { Self { unresolved: total, total } }

    /// Mark a proof obligation as resolved (machine-checked).
    pub fn resolve(&mut self, count: u32) {
        self.unresolved = self.unresolved.saturating_sub(count);
    }

    /// PO-E2: returns Err(ProofDebtExceeded) if debt is at maximum.
    pub fn check(&self) -> Result<(), TrapCode> {
        if self.unresolved >= MAX_PROOF_DEBT {
            Err(TrapCode::ProofDebtExceeded)
        } else {
            Ok(())
        }
    }

    pub fn all_closed(&self) -> bool { self.unresolved == 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn po_e1_before_sunset() {
        let p = SunsetPolicy::new(1000);
        assert_eq!(p.check(999), Ok(()));
    }

    #[test]
    fn po_e1_at_sunset() {
        let p = SunsetPolicy::new(1000);
        assert_eq!(p.check(1000), Err(TrapCode::SunsetExpired));
    }

    #[test]
    fn po_e1_after_sunset() {
        let p = SunsetPolicy::new(1000);
        assert_eq!(p.check(9999), Err(TrapCode::SunsetExpired));
    }

    #[test]
    fn po_e2_debt_exceeded() {
        let ledger = ProofDebtLedger::new(13);
        assert_eq!(ledger.check(), Err(TrapCode::ProofDebtExceeded));
    }

    #[test]
    fn po_e2_debt_resolved() {
        let mut ledger = ProofDebtLedger::new(13);
        ledger.resolve(13);
        assert_eq!(ledger.check(), Ok(()));
        assert!(ledger.all_closed());
    }

    #[test]
    fn po_e2_partial_resolve() {
        let mut ledger = ProofDebtLedger::new(13);
        ledger.resolve(5);  // 8 remain — still exceeded
        assert_eq!(ledger.unresolved, 8);
        assert_eq!(ledger.check(), Err(TrapCode::ProofDebtExceeded));
    }
}