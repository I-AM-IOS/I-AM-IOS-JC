// ════════════════════════════════════════════════════════════════════════════
//  rekernel-fork-bridge.js  —  Fork Resolution (pure JS bridge)
//
//  Direct port of rekernel/network/fork_resolution.ts into plain ES-module
//  JavaScript. Wired into sovereign-network.js FORK_PROOF handler.
//
//  The single resolution rule:
//    1. Higher cumulative finality weight (sum of stake×reputation of
//       precommitting validators) wins.
//    2. Equal weight → lower block hash wins (lexicographic, no coordinator).
//
//  Exports:
//    computeFinalityWeight(commits, validators)  → number
//    buildForkBranch(blockHash, transHash, commits, validators) → ForkBranch
//    resolveFork(fork)                           → ForkResolution
//    verifyForkResolution(resolution, fork)      → { valid, violations }
//    buildForkProof(height, winner, loser)       → ForkProof   (for local use)
// ════════════════════════════════════════════════════════════════════════════

// ── SHA-256 helper (Node crypto or SubtleCrypto) ──────────────────────────────

async function sha256hex(str) {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf    = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function sha256sync(str) {
  // Synchronous version — used only where async is not possible
  // Falls back to a deterministic FNV digest if Node crypto unavailable
  try {
    // Node.js: createHash is synchronous
    const { createHash } = globalThis._nodeCrypto ?? {};
    if (createHash) return createHash('sha256').update(str, 'utf8').digest('hex');
  } catch (_) {}
  // Browser fallback: FNV-32 (weaker but deterministic for tiebreaks)
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ── Core fork resolution functions ───────────────────────────────────────────

/**
 * Compute the finality weight of a branch.
 * Weight = sum of stake×reputation of unique precommitting validators.
 *
 * @param {Array}  commits    — array of { blockHash, precommits: [{ validatorId }] }
 * @param {object} validators — ValidatorSetSnapshot (from rekernel-esa-bridge.js)
 * @returns {number}
 */
export function computeFinalityWeight(commits, validators) {
  const counted    = new Set();
  let   totalWeight = 0;

  for (const commit of commits) {
    for (const precommit of commit.precommits ?? []) {
      if (counted.has(precommit.validatorId)) continue;
      counted.add(precommit.validatorId);
      const v = validators.validators.find(
        v => v.id === precommit.validatorId && v.isActive
      );
      if (v) totalWeight += v.stake * Math.max(0, Math.min(1, v.reputation));
    }
  }
  return totalWeight;
}

/**
 * Build a ForkBranch object from raw data.
 *
 * @param {string} blockHash
 * @param {string} transitionHash
 * @param {Array}  commits
 * @param {object} validators — ValidatorSetSnapshot
 * @returns {ForkBranch}
 */
export function buildForkBranch(blockHash, transitionHash, commits, validators) {
  return Object.freeze({
    blockHash,
    transitionHash,
    commits:       Object.freeze([...commits]),
    finalityWeight: computeFinalityWeight(commits, validators),
  });
}

/**
 * Build a verifiable proof of fork resolution.
 * Any node can independently recompute and verify this.
 */
export function buildForkProof(height, winner, loser) {
  const proofData = JSON.stringify({
    height,
    winnerHash:   winner.blockHash,
    loserHash:    loser.blockHash,
    winnerWeight: winner.finalityWeight,
    loserWeight:  loser.finalityWeight,
  });
  const proofHash = sha256sync(proofData);
  return Object.freeze({
    height,
    winnerHash:   winner.blockHash,
    loserHash:    loser.blockHash,
    winnerWeight: winner.finalityWeight,
    loserWeight:  loser.finalityWeight,
    proofHash,
  });
}

/**
 * Resolve a fork deterministically.
 *
 * @param {{ height, chainA: ForkBranch, chainB: ForkBranch, detectedAt }} fork
 * @returns {ForkResolution}
 */
export function resolveFork(fork) {
  const { chainA, chainB } = fork;

  let winningBranch;
  let method;

  if (chainA.finalityWeight !== chainB.finalityWeight) {
    winningBranch = chainA.finalityWeight > chainB.finalityWeight ? 'A' : 'B';
    method        = 'finality_weight';
  } else {
    // Deterministic tiebreak — no coordinator needed
    winningBranch = chainA.blockHash < chainB.blockHash ? 'A' : 'B';
    method        = 'hash_tiebreak';
  }

  const winner = winningBranch === 'A' ? chainA : chainB;
  const loser  = winningBranch === 'A' ? chainB : chainA;
  const proof  = buildForkProof(fork.height, winner, loser);

  return Object.freeze({
    winningBranch,
    winningHash:  winner.blockHash,
    losingHash:   loser.blockHash,
    method,
    weightA:      chainA.finalityWeight,
    weightB:      chainB.finalityWeight,
    proof,
  });
}

/**
 * Verify a fork resolution proof.
 * Returns { valid: boolean, violations: string[] }.
 */
export function verifyForkResolution(resolution, fork, validators) {
  const violations = [];

  const computedWeightA = computeFinalityWeight(fork.chainA.commits, validators);
  const computedWeightB = computeFinalityWeight(fork.chainB.commits, validators);

  if (Math.abs(computedWeightA - resolution.weightA) > 0.001)
    violations.push(`Weight A mismatch: computed=${computedWeightA.toFixed(2)} stored=${resolution.weightA.toFixed(2)}`);

  if (Math.abs(computedWeightB - resolution.weightB) > 0.001)
    violations.push(`Weight B mismatch: computed=${computedWeightB.toFixed(2)} stored=${resolution.weightB.toFixed(2)}`);

  // Re-derive expected proof hash
  const proofData = JSON.stringify({
    height:       resolution.proof.height,
    winnerHash:   resolution.proof.winnerHash,
    loserHash:    resolution.proof.loserHash,
    winnerWeight: resolution.proof.winnerWeight,
    loserWeight:  resolution.proof.loserWeight,
  });
  const expectedProofHash = sha256sync(proofData);
  if (resolution.proof.proofHash !== expectedProofHash)
    violations.push('Fork proof hash is invalid (tampered)');

  // Verify the winner is the correct choice given the rule
  const expectedWinner = computedWeightA !== computedWeightB
    ? (computedWeightA > computedWeightB ? fork.chainA.blockHash : fork.chainB.blockHash)
    : (fork.chainA.blockHash < fork.chainB.blockHash ? fork.chainA.blockHash : fork.chainB.blockHash);

  if (resolution.winningHash !== expectedWinner)
    violations.push(
      `Wrong winner: resolution says ${resolution.winningHash.slice(0, 12)}… ` +
      `but rule computes ${expectedWinner.slice(0, 12)}…`
    );

  return { valid: violations.length === 0, violations };
}
