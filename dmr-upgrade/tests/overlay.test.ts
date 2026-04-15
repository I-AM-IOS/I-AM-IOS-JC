/**
 * OVERLAY TEST SUITE — v2 (+ DMR routing tests)
 *
 * Tests for:
 *   - CID construction, parsing, and verification
 *   - CAP issuance, verification, delegation, and revocation
 *   - Endpoint scoring and selection
 *   - DAG event creation, verification, and state replay
 *   - Overlay routing — v1 compatibility + v2 DMR
 *   - DMR: deterministic edge cost, canonical path ordering, tie-breaking
 *   - DMR: capability filtering gate
 *   - DMR: canonical route sets (primary + backups)
 *   - DMR: failover trigger determination and backup activation
 *   - DMR: routing DAG events (ROUTE_SET_COMPUTED, etc.)
 *   - DMR: convergence guarantee (same state → same route set)
 *   - Connection lifecycle (mocked transport)
 *   - Registry store / resolve
 *
 * Run with: ts-node tests/overlay.test.ts
 */

import {
  buildCIDString, parseCID, createCIDRecord, verifyCIDRecord,
  computeRecordHash, deriveKeyId, rotateCIDKey, withServicePath, rootCID,
} from '../src/cid/cid';

import {
  issueCAP, verifyCAP, delegateCAP, scopeCovers,
  enforceCapability, InMemoryRevocationStore,
} from '../src/capability/capability';

import {
  createEPD, scoreEPD, selectBestEPD, rankEPDs,
  deduplicateEPDs, updateEPDTrust,
} from '../src/endpoint/endpoint';

import {
  createOverlayEvent, verifyOverlayEvent, replayOverlayLog,
  evtCIDCreated, evtCAPissued, evtCAPRevoked, evtPeerDiscovered,
  evtSessionEstablished, emptyOverlayState,
  evtRouteSetComputed, evtRouteActivatedPrimary,
  evtRouteFailoverTriggered, evtRouteSwitched,
} from '../src/dag/dag-events';

import {
  buildRoutingTable, selectRoute, isReachable, directReachableCIDs,
  computeCanonicalRouteSet, comparePathsDeterministic,
  computeEdgeCost, computePathCost, enumerateSimplePaths,
  determineFailoverTrigger, activateNextBackup,
  hashRoutingTableState, selectBestEPDByLowestCost,
  nodePassesCapabilityFilter,
  DMR_CONSTANTS, DMR_PROTOCOL_VERSION,
  CanonicalRouteSet, RoutingPath,
} from '../src/routing/overlay-routing';

import { InMemoryCIDRegistry } from '../src/cid/cid-registry';

// ── Test Harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errors: string[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result.then(() => {
        console.log(`  ✓ ${name}`);
        passed++;
      }).catch((err: any) => {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        errors.push(name);
        failed++;
      });
    } else {
      console.log(`  ✓ ${name}`);
      passed++;
    }
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    errors.push(name);
    failed++;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(a: T, b: T, message?: string): void {
  if (a !== b) throw new Error(message ?? `Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`);
}

function assertClose(a: number, b: number, tolerance = 1e-9, message?: string): void {
  if (Math.abs(a - b) > tolerance) {
    throw new Error(message ?? `Expected ${a} ≈ ${b} (tolerance ${tolerance})`);
  }
}

// ── Stub Crypto ───────────────────────────────────────────────────────────────

const STUB_PUBKEY = 'ed25519:deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb';

function stubSign(message: string): string {
  const { canonicalJsonHashSync } = require('../src/canonical-json');
  return 'sig:' + canonicalJsonHashSync({ message });
}

function stubVerify(pubkey: string, message: string, signature: string): boolean {
  const { canonicalJsonHashSync } = require('../src/canonical-json');
  return signature === 'sig:' + canonicalJsonHashSync({ message });
}

// ── Shared Fixtures ───────────────────────────────────────────────────────────

const ISSUER_CID  = 'cid:iam:aaaa1111';
const SUBJECT_CID = 'cid:iam:bbbb2222';
const TARGET_CID  = 'cid:iam:cccc3333';

function makeToken(overrides: Partial<Parameters<typeof issueCAP>[0]> = {}) {
  return issueCAP({
    subjectCID:   SUBJECT_CID,
    targetCID:    TARGET_CID,
    scope:        '/app/drone',
    actions:      ['read', 'write'],
    issuerCID:    ISSUER_CID,
    issuerPubkey: STUB_PUBKEY,
    constraints:  { ttl: 600 },
    sign:         stubSign,
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CID TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[CID]');

test('parseCID: valid CID without service path', () => {
  const parsed = parseCID('cid:iam:abc123');
  assert(parsed !== null, 'should parse');
  assertEqual(parsed!.keyId, 'abc123');
  assertEqual(parsed!.servicePath, null);
});

test('parseCID: valid CID with service path', () => {
  const parsed = parseCID('cid:iam:abc123//app/drone/control');
  assert(parsed !== null, 'should parse');
  assertEqual(parsed!.keyId, 'abc123');
  assertEqual(parsed!.servicePath, 'app/drone/control');
});

test('parseCID: invalid scheme returns null', () => {
  assertEqual(parseCID('invalid:abc'), null);
  assertEqual(parseCID(''), null);
  assertEqual(parseCID('cid:other:abc'), null);
});

test('buildCIDString: round-trips correctly', () => {
  const cid = buildCIDString('abc123', 'app/sensor');
  assertEqual(cid, 'cid:iam:abc123//app/sensor');
  const parsed = parseCID(cid);
  assertEqual(parsed!.keyId, 'abc123');
  assertEqual(parsed!.servicePath, 'app/sensor');
});

test('createCIDRecord: produces valid record', () => {
  const record = createCIDRecord({ pubkey: STUB_PUBKEY, sign: stubSign });
  assert(record.cid.startsWith('cid:iam:'), 'CID should start with cid:iam:');
  assert(record.epoch === 1, 'epoch should be 1');
  assert(record.recordHash.length === 64, 'should be SHA-256 hex');
});

test('verifyCIDRecord: accepts a valid record', () => {
  const record = createCIDRecord({ pubkey: STUB_PUBKEY, sign: stubSign });
  const result = verifyCIDRecord(record, stubVerify);
  assert(result.ok, result.ok ? '' : result.reason);
});

test('verifyCIDRecord: rejects tampered hash', () => {
  const record  = createCIDRecord({ pubkey: STUB_PUBKEY, sign: stubSign });
  const tampered = { ...record, epoch: 99 };
  const result  = verifyCIDRecord(tampered, stubVerify);
  assert(!result.ok, 'should reject tampered record');
});

test('rotateCIDKey: increments epoch and changes CID', () => {
  const r1 = createCIDRecord({ pubkey: STUB_PUBKEY, sign: stubSign });
  const newPubkey = 'ed25519:1111111111111111111111111111111111111111111111111111111111111111';
  const r2 = rotateCIDKey(r1, newPubkey, 'ed25519', stubSign);
  assert(r2.epoch === r1.epoch + 1, 'epoch should increment');
  assert(r2.cid !== r1.cid, 'CID should change on key rotation');
  const valid = verifyCIDRecord(r2, stubVerify);
  assert(valid.ok, valid.ok ? '' : valid.reason);
});

test('withServicePath / rootCID utilities', () => {
  const record = createCIDRecord({ pubkey: STUB_PUBKEY, sign: stubSign });
  const full   = withServicePath(record.cid, 'app/drone');
  assert(full.includes('//app/drone'), 'should append service path');
  assertEqual(rootCID(full), record.cid);
});

// ─────────────────────────────────────────────────────────────────────────────
// CAPABILITY TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[CAP]');

test('issueCAP: produces a valid token with correct id', () => {
  const token = makeToken();
  assert(token.id.length === 64, 'id should be SHA-256 hex');
  assert(token.signature.startsWith('sig:'), 'should have signature');
});

test('verifyCAP: accepts a valid token', () => {
  const token  = makeToken();
  const result = verifyCAP(token, {
    requestingCID:   SUBJECT_CID,
    targetCID:       TARGET_CID,
    requestedScope:  '/app/drone/control',
    requestedAction: 'read',
    verifySignature: stubVerify,
  });
  assert(result.ok, result.ok ? '' : `[${result.code}] ${result.reason}`);
});

test('verifyCAP V3: rejects wrong subject CID', () => {
  const token  = makeToken();
  const result = verifyCAP(token, {
    requestingCID:   'cid:iam:wrong',
    targetCID:       TARGET_CID,
    requestedScope:  '/app/drone',
    requestedAction: 'read',
    verifySignature: stubVerify,
  });
  assert(!result.ok && result.code === 'V3', 'should fail V3');
});

test('verifyCAP V5: rejects out-of-scope request', () => {
  const token  = makeToken({ scope: '/app/drone' });
  const result = verifyCAP(token, {
    requestingCID:   SUBJECT_CID,
    targetCID:       TARGET_CID,
    requestedScope:  '/app/camera',
    requestedAction: 'read',
    verifySignature: stubVerify,
  });
  assert(!result.ok && result.code === 'V5', 'should fail V5');
});

test('verifyCAP V6: rejects unpermitted action', () => {
  const token  = makeToken({ actions: ['read'] });
  const result = verifyCAP(token, {
    requestingCID:   SUBJECT_CID,
    targetCID:       TARGET_CID,
    requestedScope:  '/app/drone',
    requestedAction: 'execute',
    verifySignature: stubVerify,
  });
  assert(!result.ok && result.code === 'V6', 'should fail V6');
});

test('verifyCAP V7: rejects expired token', () => {
  const token  = makeToken({ constraints: { ttl: 1 } });
  const result = verifyCAP(token, {
    requestingCID:   SUBJECT_CID,
    targetCID:       TARGET_CID,
    requestedScope:  '/app/drone',
    requestedAction: 'read',
    nowMs:           token.claim.issuedAt + 5_000,
    verifySignature: stubVerify,
  });
  assert(!result.ok && result.code === 'V7', 'should fail V7');
});

test('verifyCAP V8: rejects revoked token', () => {
  const token  = makeToken();
  const store  = new InMemoryRevocationStore();
  store.revoke({ capId: token.id, reason: 'test', revokedAt: Date.now(), revokedBy: ISSUER_CID });
  const result = verifyCAP(token, {
    requestingCID:   SUBJECT_CID,
    targetCID:       TARGET_CID,
    requestedScope:  '/app/drone',
    requestedAction: 'read',
    revocationStore: store,
    verifySignature: stubVerify,
  });
  assert(!result.ok && result.code === 'V8', 'should fail V8');
});

test('scopeCovers: correct prefix matching', () => {
  assert(scopeCovers('/app', '/app/drone'),       '/app covers /app/drone');
  assert(scopeCovers('/app/drone', '/app/drone'), 'identical scopes');
  assert(scopeCovers('/', '/anything'),            '/ covers everything');
  assert(!scopeCovers('/app/drone', '/app'),       'parent does not cover child');
  assert(!scopeCovers('/app/drone', '/app/camera'),'sibling does not cover sibling');
});

test('delegateCAP: narrows scope and actions', () => {
  const parent = makeToken({ actions: ['read', 'write', 'execute'], scope: '/app' });
  const child  = delegateCAP({
    parentToken:     parent,
    delegateeCID:    'cid:iam:delegatee',
    scope:           '/app/drone',
    actions:         ['read'],
    delegatorCID:    SUBJECT_CID,
    delegatorPubkey: STUB_PUBKEY,
    sign:            stubSign,
  });
  assert(child !== null, 'delegation should succeed');
  assertEqual(child!.claim.scope,  '/app/drone');
  assertEqual(child!.parentId,     parent.id);
});

test('delegateCAP: rejects scope escalation', () => {
  const parent = makeToken({ scope: '/app/drone' });
  const child  = delegateCAP({
    parentToken:     parent,
    delegateeCID:    'cid:iam:delegatee',
    scope:           '/app',
    actions:         ['read'],
    delegatorCID:    SUBJECT_CID,
    delegatorPubkey: STUB_PUBKEY,
    sign:            stubSign,
  });
  assertEqual(child, null, 'scope escalation should be rejected');
});

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[EPD]');

test('createEPD: produces canonical hash', () => {
  const epd1 = createEPD({ cid: 'cid:iam:abc', transport: 'quic', address: '1.2.3.4:4433' });
  const epd2 = createEPD({ cid: 'cid:iam:abc', transport: 'quic', address: '1.2.3.4:4433' });
  assertEqual(epd1.epHash, epd2.epHash, 'same params → same hash');
});

test('selectBestEPD: prefers quic over relay', () => {
  const quic  = createEPD({ cid: 'x', transport: 'quic',  address: '1.2.3.4:4433', trustScore: 0.8 });
  const relay = createEPD({ cid: 'x', transport: 'relay', address: 'cid:iam:relay1', trustScore: 0.9 });
  const best  = selectBestEPD([relay, quic]);
  assertEqual(best!.transport, 'quic', 'quic should win despite lower trust');
});

test('updateEPDTrust: converges toward observed value', () => {
  const epd     = createEPD({ cid: 'x', transport: 'quic', address: 'a:1', trustScore: 0.5 });
  const updated = updateEPDTrust(epd, false);
  assert(updated.trustScore < epd.trustScore, 'trust should decrease on failure');
});

test('deduplicateEPDs: keeps highest trust per (cid,transport,address)', () => {
  const base  = createEPD({ cid: 'x', transport: 'quic', address: 'a:1', trustScore: 0.3 });
  const high  = createEPD({ cid: 'x', transport: 'quic', address: 'a:1', trustScore: 0.9 });
  const other = createEPD({ cid: 'x', transport: 'tcp',  address: 'a:80' });
  const deduped = deduplicateEPDs([base, high, other]);
  assertEqual(deduped.length, 2, 'should dedup to 2');
  const quicEntry = deduped.find(e => e.transport === 'quic');
  assertEqual(quicEntry!.trustScore, 0.9, 'should keep highest trust');
});

// ─────────────────────────────────────────────────────────────────────────────
// DAG EVENT TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[DAG Events]');

test('createOverlayEvent: produces correct id and hash', () => {
  const record = createCIDRecord({ pubkey: STUB_PUBKEY, sign: stubSign });
  const event  = evtCIDCreated('cid:iam:actor', record, null);
  const verify = verifyOverlayEvent(event, event.timestamp);
  assert(verify.ok, verify.ok ? '' : `[${verify.code}] ${verify.reason}`);
});

test('verifyOverlayEvent OE5: rejects stale event', () => {
  const record  = createCIDRecord({ pubkey: STUB_PUBKEY, sign: stubSign });
  const event   = evtCIDCreated('cid:iam:actor', record, null, Date.now() - 10 * 60_000);
  const verify  = verifyOverlayEvent(event, Date.now());
  assert(!verify.ok && verify.code === 'OE5', 'should fail OE5 on stale event');
});

test('verifyOverlayEvent OE2: rejects event with tampered prevHash', () => {
  const record   = createCIDRecord({ pubkey: STUB_PUBKEY, sign: stubSign });
  const event    = evtCIDCreated('cid:iam:actor', record, null);
  const tampered = { ...event, prevHash: 'aaaa' + event.hash.slice(4) };
  const verify   = verifyOverlayEvent(tampered as any, event.timestamp);
  assert(!verify.ok && verify.code === 'OE2', `expected OE2, got ${verify.ok ? 'ok' : verify.code}`);
});

test('replayOverlayLog: CID_CREATED → CID in registry', () => {
  const record  = createCIDRecord({ pubkey: STUB_PUBKEY, sign: stubSign });
  const token   = makeToken();
  const events  = [
    evtCIDCreated('cid:iam:actor', record, null),
    evtCAPissued('cid:iam:actor', token, null),
  ];
  const state = replayOverlayLog(events);
  assert(state.cidRegistry.has(record.cid), 'CID should be in registry after replay');
  assert(state.capIndex.has(token.id),      'CAP should be in index after replay');
});

test('replayOverlayLog: CAP_REVOKED removes from index', () => {
  const token  = makeToken();
  const events = [
    evtCAPissued('cid:iam:actor', token, null),
    evtCAPRevoked('cid:iam:actor', token.id, 'test', 'cid:iam:actor', null),
  ];
  const state = replayOverlayLog(events);
  assert(!state.capIndex.has(token.id),       'CAP should be removed from index');
  assert(state.revocationList.has(token.id),  'CAP should be in revocation list');
});

test('replayOverlayLog: SESSION lifecycle', () => {
  const record = createCIDRecord({ pubkey: STUB_PUBKEY, sign: stubSign });
  const token  = makeToken();
  const sessId = 'session-001';

  const events: any[] = [];
  events.push(evtCIDCreated(record.cid, record, null));
  events.push(evtSessionEstablished(record.cid, record.cid, TARGET_CID, sessId, 'quic', token.id, null));

  let state = replayOverlayLog(events);
  assert(state.activeSessions.has(sessId), 'session should be active');

  events.push(createOverlayEvent('overlay.SESSION_CLOSED', record.cid,
    { sessionId: sessId, reason: 'normal', durationMs: 1000 }, null));

  state = replayOverlayLog(events);
  assert(!state.activeSessions.has(sessId), 'session should be closed after replay');
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTING v1 COMPATIBILITY TESTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[Routing — v1 compat]');

function makeStateWithPeers(...peers: Array<{ cid: string; transport: 'quic' | 'relay' | 'tcp' | 'webrtc' }>) {
  const state = emptyOverlayState();
  for (const peer of peers) {
    const epd = createEPD({ cid: peer.cid, transport: peer.transport, address: 'a:1' });
    state.peerGraph.set(peer.cid, [epd]);
  }
  return state;
}

test('buildRoutingTable: direct peers populated', () => {
  const state = makeStateWithPeers(
    { cid: 'cid:iam:p1', transport: 'quic'  },
    { cid: 'cid:iam:p2', transport: 'relay' },
  );
  const table = buildRoutingTable(state);
  assert(table.directPeers.has('cid:iam:p1'), 'p1 should be in routing table');
  assert(table.directPeers.has('cid:iam:p2'), 'p2 should be in routing table');
  assert(table.relayReach.has('cid:iam:p2'), 'p2 should be relay-reachable');
});

test('selectRoute: picks direct path (returns primary from route set)', () => {
  const s = emptyOverlayState();
  s.peerGraph.set('cid:iam:target', [
    createEPD({ cid: 'cid:iam:target', transport: 'quic',  address: '1.2.3.4:4433' }),
    createEPD({ cid: 'cid:iam:target', transport: 'relay', address: 'cid:iam:r1' }),
  ]);
  const table = buildRoutingTable(s);
  const route = selectRoute(table, { localCID: 'cid:iam:local', targetCID: 'cid:iam:target' });
  assert(route !== null, 'should find a route');
  assert(route!.isDirect, 'should prefer direct route');
});

test('selectRoute: returns null for unknown CID', () => {
  const table = buildRoutingTable(emptyOverlayState());
  const route = selectRoute(table, { localCID: 'cid:iam:local', targetCID: 'cid:iam:unknown' });
  assertEqual(route, null, 'unknown CID should return null');
});

test('isReachable: true for known peers', () => {
  const state = makeStateWithPeers({ cid: 'cid:iam:peer', transport: 'quic' });
  const table = buildRoutingTable(state);
  assert(isReachable(table, 'cid:iam:peer'),   'peer should be reachable');
  assert(!isReachable(table, 'cid:iam:ghost'), 'unknown CID should not be reachable');
});

// ─────────────────────────────────────────────────────────────────────────────
// DMR — PROTOCOL CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[DMR — Protocol Constants]');

test('DMR_PROTOCOL_VERSION is 1', () => {
  assertEqual(DMR_PROTOCOL_VERSION, 1);
});

test('DMR_CONSTANTS weights sum to 1.0 (LATENCY + FAILURE + TRUST + HOP)', () => {
  const sum = DMR_CONSTANTS.WEIGHT_LATENCY
            + DMR_CONSTANTS.WEIGHT_FAILURE
            + DMR_CONSTANTS.WEIGHT_TRUST
            + DMR_CONSTANTS.WEIGHT_HOP;
  assertClose(sum, 1.0, 1e-10, `Weights must sum to 1.0, got ${sum}`);
});

test('DMR_CONSTANTS: MAX_PATHS >= 2 and MAX_HOPS >= 2', () => {
  assert(DMR_CONSTANTS.MAX_PATHS >= 2, 'need at least primary + 1 backup');
  assert(DMR_CONSTANTS.MAX_HOPS  >= 2, 'need at least 2 hops for relay');
});

// ─────────────────────────────────────────────────────────────────────────────
// DMR — DETERMINISTIC EDGE COST
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[DMR — Edge Cost]');

test('computeEdgeCost: pure function — same input → same output', () => {
  const epd  = createEPD({ cid: 'x', transport: 'quic', address: 'a:1', latencyMs: 50, trustScore: 0.9 });
  const c1   = computeEdgeCost(epd);
  const c2   = computeEdgeCost(epd);
  assertEqual(c1, c2, 'cost must be deterministic');
});

test('computeEdgeCost: lower latency → lower cost', () => {
  const fast = createEPD({ cid: 'x', transport: 'quic', address: 'a:1', latencyMs: 10,  trustScore: 0.8 });
  const slow = createEPD({ cid: 'x', transport: 'quic', address: 'a:1', latencyMs: 500, trustScore: 0.8 });
  assert(computeEdgeCost(fast) < computeEdgeCost(slow), 'faster should cost less');
});

test('computeEdgeCost: higher trust → lower cost', () => {
  const trusted   = createEPD({ cid: 'x', transport: 'quic', address: 'a:1', latencyMs: 50, trustScore: 0.95 });
  const untrusted = createEPD({ cid: 'x', transport: 'quic', address: 'a:1', latencyMs: 50, trustScore: 0.10 });
  assert(computeEdgeCost(trusted) < computeEdgeCost(untrusted), 'trusted should cost less');
});

test('computeEdgeCost: result in [0, 1]', () => {
  const worst = createEPD({ cid: 'x', transport: 'relay', address: 'a:1', latencyMs: 9999, trustScore: 0.0 });
  const best  = createEPD({ cid: 'x', transport: 'quic',  address: 'a:1', latencyMs: 0,    trustScore: 1.0 });
  const costW = computeEdgeCost(worst);
  const costB = computeEdgeCost(best);
  assert(costW >= 0 && costW <= 1.0 + DMR_CONSTANTS.WEIGHT_HOP, `worst cost out of range: ${costW}`);
  assertEqual(costB, 0, 'perfect EPD should have zero edge cost');
});

test('computePathCost: includes hop penalty', () => {
  const epd  = createEPD({ cid: 'x', transport: 'quic', address: 'a:1', latencyMs: 0, trustScore: 1.0 });
  const hop1 = [{ cid: 'cid:iam:t', endpoint: epd }];
  const hop2 = [{ cid: 'cid:iam:r', endpoint: epd }, { cid: 'cid:iam:t', endpoint: epd }];
  assert(computePathCost(hop2) > computePathCost(hop1), '2-hop should cost more than 1-hop');
});

// ─────────────────────────────────────────────────────────────────────────────
// DMR — DETERMINISTIC PATH COMPARATOR & ORDERING
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[DMR — Path Ordering]');

test('comparePathsDeterministic: lower cost wins', () => {
  const cheapEPD = createEPD({ cid: 'cid:iam:t', transport: 'quic', address: 'a:1', latencyMs: 10,  trustScore: 0.9 });
  const pricyEPD = createEPD({ cid: 'cid:iam:t', transport: 'quic', address: 'a:1', latencyMs: 500, trustScore: 0.4 });
  const cheap: RoutingPath = {
    targetCID: 'cid:iam:t', hops: [{ cid: 'cid:iam:t', endpoint: cheapEPD }],
    totalCost: computePathCost([{ cid: 'cid:iam:t', endpoint: cheapEPD }]),
    transport: 'quic', isDirect: true, isRelay: false,
  };
  const pricey: RoutingPath = {
    targetCID: 'cid:iam:t', hops: [{ cid: 'cid:iam:t', endpoint: pricyEPD }],
    totalCost: computePathCost([{ cid: 'cid:iam:t', endpoint: pricyEPD }]),
    transport: 'quic', isDirect: true, isRelay: false,
  };
  assert(comparePathsDeterministic(cheap, pricey) < 0, 'cheaper path should sort first');
});

test('comparePathsDeterministic: on equal cost, fewer hops wins', () => {
  const epd = createEPD({ cid: 'cid:iam:t', transport: 'quic', address: 'a:1', latencyMs: 0, trustScore: 1.0 });
  const relay = createEPD({ cid: 'cid:iam:r', transport: 'quic', address: 'b:1', latencyMs: 0, trustScore: 1.0 });
  const direct: RoutingPath = {
    targetCID: 'cid:iam:t',
    hops: [{ cid: 'cid:iam:t', endpoint: epd }],
    totalCost: 0,
    transport: 'quic', isDirect: true, isRelay: false,
  };
  const twoHop: RoutingPath = {
    targetCID: 'cid:iam:t',
    hops: [{ cid: 'cid:iam:r', endpoint: relay }, { cid: 'cid:iam:t', endpoint: epd }],
    totalCost: 0,
    transport: 'quic', isDirect: false, isRelay: false,
  };
  assert(comparePathsDeterministic(direct, twoHop) < 0, 'direct should sort before 2-hop when cost equal');
});

test('comparePathsDeterministic: equal cost+hops → stable tie-break by CID hash', () => {
  const epd = createEPD({ cid: 'x', transport: 'quic', address: 'a:1', latencyMs: 0, trustScore: 1.0 });
  const p1: RoutingPath = {
    targetCID: 'cid:iam:t', hops: [{ cid: 'cid:iam:aaa', endpoint: epd }],
    totalCost: 0, transport: 'quic', isDirect: true, isRelay: false,
  };
  const p2: RoutingPath = {
    targetCID: 'cid:iam:t', hops: [{ cid: 'cid:iam:zzz', endpoint: epd }],
    totalCost: 0, transport: 'quic', isDirect: true, isRelay: false,
  };
  const cmp1 = comparePathsDeterministic(p1, p2);
  const cmp2 = comparePathsDeterministic(p1, p2);
  assertEqual(cmp1, cmp2, 'comparator must be stable (same result every call)');
  assert(cmp1 !== 0, 'different CID sequences must produce non-zero comparison');
});

// ─────────────────────────────────────────────────────────────────────────────
// DMR — CANONICAL ROUTE SET
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[DMR — Canonical Route Set]');

function makeDMRState() {
  const state = emptyOverlayState();
  // Direct QUIC path to target
  state.peerGraph.set('cid:iam:target', [
    createEPD({ cid: 'cid:iam:target', transport: 'quic', address: '10.0.0.1:4433', latencyMs: 20, trustScore: 0.9 }),
  ]);
  // Relay path
  state.peerGraph.set('cid:iam:relay1', [
    createEPD({ cid: 'cid:iam:relay1', transport: 'relay', address: 'cid:iam:relay1', latencyMs: 100, trustScore: 0.7 }),
  ]);
  return state;
}

test('computeCanonicalRouteSet: returns non-null for reachable target', () => {
  const state = makeDMRState();
  const table = buildRoutingTable(state);
  const rs = computeCanonicalRouteSet(table, {
    localCID: 'cid:iam:local',
    targetCID: 'cid:iam:target',
  });
  assert(rs !== null, 'should find a route set');
  assert(rs!.primary !== null, 'should have a primary path');
});

test('computeCanonicalRouteSet: returns null for unknown target', () => {
  const table = buildRoutingTable(emptyOverlayState());
  const rs = computeCanonicalRouteSet(table, {
    localCID: 'cid:iam:local',
    targetCID: 'cid:iam:ghost',
  });
  assertEqual(rs, null, 'unreachable target should return null');
});

test('computeCanonicalRouteSet: primary path is lowest cost', () => {
  const state = makeDMRState();
  const table = buildRoutingTable(state);
  const rs = computeCanonicalRouteSet(table, {
    localCID:  'cid:iam:local',
    targetCID: 'cid:iam:target',
  });
  assert(rs !== null, 'should find route set');
  const all = [rs!.primary, ...rs!.backups];
  for (const backup of rs!.backups) {
    assert(
      rs!.primary.totalCost <= backup.totalCost,
      `primary (${rs!.primary.totalCost}) must be ≤ backup (${backup.totalCost})`,
    );
  }
});

test('computeCanonicalRouteSet: protocolVersion and stateHash fields set', () => {
  const state = makeDMRState();
  const table = buildRoutingTable(state);
  const sh = hashRoutingTableState(table);
  const rs  = computeCanonicalRouteSet(table, {
    localCID:  'cid:iam:local',
    targetCID: 'cid:iam:target',
    stateHash: sh,
  });
  assert(rs !== null, 'should find route set');
  assertEqual(rs!.protocolVersion, DMR_PROTOCOL_VERSION);
  assertEqual(rs!.stateHash, sh);
});

test('computeCanonicalRouteSet: maxPaths limits backup count', () => {
  const state = makeDMRState();
  const table = buildRoutingTable(state);
  const rs = computeCanonicalRouteSet(table, {
    localCID:  'cid:iam:local',
    targetCID: 'cid:iam:target',
    maxPaths:  2,
  });
  assert(rs !== null, 'should find route set');
  assert(rs!.backups.length <= 1, `max 1 backup when maxPaths=2, got ${rs!.backups.length}`);
});

// ── THE CORE GUARANTEE ────────────────────────────────────────────────────────

test('DMR convergence: identical state → identical route set on two independent computations', () => {
  const state = makeDMRState();
  const table = buildRoutingTable(state);
  const opts  = { localCID: 'cid:iam:local', targetCID: 'cid:iam:target' };

  // Simulate "two nodes" independently computing the route set from the same state
  const rsA = computeCanonicalRouteSet(buildRoutingTable(state), opts);
  const rsB = computeCanonicalRouteSet(buildRoutingTable(state), opts);

  assert(rsA !== null && rsB !== null, 'both should find a route set');

  const primaryHopsA = rsA!.primary.hops.map(h => h.cid).join('→');
  const primaryHopsB = rsB!.primary.hops.map(h => h.cid).join('→');
  assertEqual(primaryHopsA, primaryHopsB, 'primary path must be identical on both nodes');

  assertEqual(rsA!.backups.length, rsB!.backups.length, 'backup count must match');
  for (let i = 0; i < rsA!.backups.length; i++) {
    const hA = rsA!.backups[i].hops.map(h => h.cid).join('→');
    const hB = rsB!.backups[i].hops.map(h => h.cid).join('→');
    assertEqual(hA, hB, `backup[${i}] must match`);
  }
});

test('DMR convergence: order is stable across multiple calls', () => {
  const state = makeDMRState();
  const opts  = { localCID: 'cid:iam:local', targetCID: 'cid:iam:target' };
  const rs1 = computeCanonicalRouteSet(buildRoutingTable(state), opts);
  const rs2 = computeCanonicalRouteSet(buildRoutingTable(state), opts);
  assert(rs1 !== null && rs2 !== null);
  assertEqual(
    rs1!.primary.totalCost.toFixed(15),
    rs2!.primary.totalCost.toFixed(15),
    'primary cost must be identical across calls',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// DMR — CAPABILITY FILTERING
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[DMR — Capability Filtering]');

test('nodePassesCapabilityFilter: passes when no scope required', () => {
  const table = buildRoutingTable(emptyOverlayState());
  assert(
    nodePassesCapabilityFilter('cid:iam:any', 'cid:iam:target', undefined, table),
    'should pass with no scope filter',
  );
});

test('nodePassesCapabilityFilter: intermediate nodes always pass', () => {
  const table = buildRoutingTable(emptyOverlayState());
  assert(
    nodePassesCapabilityFilter('cid:iam:hop1', 'cid:iam:target', '/app/drone', table),
    'intermediate nodes should not be filtered',
  );
});

test('nodePassesCapabilityFilter: target node requires cap edge', () => {
  const state = emptyOverlayState();
  const token = issueCAP({
    subjectCID:   'cid:iam:target',
    targetCID:    'cid:iam:target',
    scope:        '/app',
    actions:      ['read'],
    issuerCID:    ISSUER_CID,
    issuerPubkey: STUB_PUBKEY,
    constraints:  {},
    sign:         stubSign,
  });
  state.capIndex.set(token.id, token);
  const table = buildRoutingTable(state);

  // /app/drone is under /app — should pass
  assert(
    nodePassesCapabilityFilter('cid:iam:target', 'cid:iam:target', '/app/drone', table),
    'target with covering cap should pass',
  );
  // /other is not under /app — should fail
  assert(
    !nodePassesCapabilityFilter('cid:iam:target', 'cid:iam:target', '/other', table),
    'target without covering cap should fail',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// DMR — FAILOVER
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[DMR — Failover]');

test('determineFailoverTrigger: revocation takes priority', () => {
  const t = determineFailoverTrigger(99999, false, false, true);
  assertEqual(t, 'revocation');
});

test('determineFailoverTrigger: signature_failure second priority', () => {
  const t = determineFailoverTrigger(99999, false, false, false);
  assertEqual(t, 'signature_failure');
});

test('determineFailoverTrigger: capability_invalid third priority', () => {
  const t = determineFailoverTrigger(99999, true, false, false);
  assertEqual(t, 'capability_invalid');
});

test('determineFailoverTrigger: timeout when only timing exceeded', () => {
  const t = determineFailoverTrigger(DMR_CONSTANTS.FAILOVER_TIMEOUT_MS + 1, true, true, false);
  assertEqual(t, 'timeout');
});

test('activateNextBackup: returns next backup when available', () => {
  const state = makeDMRState();
  const table = buildRoutingTable(state);
  const rs    = computeCanonicalRouteSet(table, {
    localCID:  'cid:iam:local',
    targetCID: 'cid:iam:target',
  });
  if (!rs) return;  // skip if no backups in this topology

  const result = activateNextBackup(rs, rs.primary, 'timeout');
  assertEqual(result.trigger, 'timeout');
  assertEqual(result.failed.hops.map(h => h.cid).join('→'),
              rs.primary.hops.map(h => h.cid).join('→'));
});

test('activateNextBackup: returns null when all backups exhausted', () => {
  const state = makeDMRState();
  const table = buildRoutingTable(state);
  const rs    = computeCanonicalRouteSet(table, {
    localCID:  'cid:iam:local',
    targetCID: 'cid:iam:target',
    maxPaths:  1,  // force no backups
  });
  if (!rs) return;

  const result = activateNextBackup(rs, rs.primary, 'timeout');
  assertEqual(result.next, null, 'no backups → next should be null');
});

// ─────────────────────────────────────────────────────────────────────────────
// DMR — ROUTING DAG EVENTS
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[DMR — Routing DAG Events]');

test('evtRouteSetComputed: produces valid overlay event', () => {
  const state = makeDMRState();
  const table = buildRoutingTable(state);
  const rs    = computeCanonicalRouteSet(table, {
    localCID:  'cid:iam:local',
    targetCID: 'cid:iam:target',
    stateHash: hashRoutingTableState(table),
  });
  assert(rs !== null, 'need a route set');

  const event  = evtRouteSetComputed('cid:iam:local', rs!, null);
  const verify = verifyOverlayEvent(event, event.timestamp);
  assert(verify.ok, verify.ok ? '' : `[${verify.code}] ${verify.reason}`);
  assertEqual(event.type, 'overlay.ROUTE_SET_COMPUTED');
});

test('evtRouteSetComputed: replays into routeSets map', () => {
  const state = makeDMRState();
  const table = buildRoutingTable(state);
  const rs    = computeCanonicalRouteSet(table, {
    localCID:  'cid:iam:local',
    targetCID: 'cid:iam:target',
  });
  assert(rs !== null);

  const events = [evtRouteSetComputed('cid:iam:local', rs!, null)];
  const newState = replayOverlayLog(events);
  const stored   = newState.routeSets.get('cid:iam:local→cid:iam:target');
  assert(stored !== undefined, 'route set should be in state after replay');
  assertEqual(stored!.targetCID, 'cid:iam:target');
});

test('evtRouteActivatedPrimary: valid event, correct type', () => {
  const state = makeDMRState();
  const table = buildRoutingTable(state);
  const rs    = computeCanonicalRouteSet(table, { localCID: 'cid:iam:local', targetCID: 'cid:iam:target' });
  assert(rs !== null);

  const event  = evtRouteActivatedPrimary(
    'cid:iam:local', 'cid:iam:local', 'cid:iam:target',
    'sess-001', rs!.primary, rs!.stateHash, null,
  );
  const verify = verifyOverlayEvent(event, event.timestamp);
  assert(verify.ok, verify.ok ? '' : `[${verify.code}] ${verify.reason}`);
  assertEqual(event.type, 'overlay.ROUTE_ACTIVATED_PRIMARY');
});

test('evtRouteFailoverTriggered: valid event with correct payload', () => {
  const state = makeDMRState();
  const table = buildRoutingTable(state);
  const rs    = computeCanonicalRouteSet(table, { localCID: 'cid:iam:local', targetCID: 'cid:iam:target' });
  assert(rs !== null);

  const next   = rs!.backups[0] ?? null;
  const event  = evtRouteFailoverTriggered(
    'cid:iam:local', 'cid:iam:local', 'cid:iam:target',
    'sess-001', 'timeout', rs!.primary, next, null,
  );
  const verify = verifyOverlayEvent(event, event.timestamp);
  assert(verify.ok, verify.ok ? '' : `[${verify.code}] ${verify.reason}`);
  assertEqual(event.type, 'overlay.ROUTE_FAILOVER_TRIGGERED');
});

test('evtRouteSwitched: audit event does not mutate structural state', () => {
  const state = makeDMRState();
  const table = buildRoutingTable(state);
  const rs    = computeCanonicalRouteSet(table, { localCID: 'cid:iam:local', targetCID: 'cid:iam:target' });
  if (!rs || rs.backups.length === 0) return;  // skip if topology has no backups

  const event = evtRouteSwitched(
    'cid:iam:local', 'cid:iam:local', 'cid:iam:target',
    'sess-001', rs.primary, rs.backups[0], 'timeout', null,
  );
  const prevState = emptyOverlayState();
  const newState  = replayOverlayLog([event]);
  // Route-switched is an audit event — it should not change cidRegistry etc.
  assertEqual(newState.cidRegistry.size, 0, 'ROUTE_SWITCHED should not mutate cidRegistry');
  assertEqual(newState.height, 1, 'height should increment');
});

// ─────────────────────────────────────────────────────────────────────────────
// DMR — hashRoutingTableState
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[DMR — State Hashing]');

test('hashRoutingTableState: same table → same hash', () => {
  const state = makeDMRState();
  const h1 = hashRoutingTableState(buildRoutingTable(state));
  const h2 = hashRoutingTableState(buildRoutingTable(state));
  assertEqual(h1, h2, 'same state must hash identically');
});

test('hashRoutingTableState: different topology → different hash', () => {
  const s1 = makeDMRState();
  const s2 = emptyOverlayState();
  const h1 = hashRoutingTableState(buildRoutingTable(s1));
  const h2 = hashRoutingTableState(buildRoutingTable(s2));
  assert(h1 !== h2, 'different topologies must produce different hashes');
});

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n[Registry]');

test('InMemoryCIDRegistry: store and resolve', async () => {
  const reg    = new InMemoryCIDRegistry();
  const record = createCIDRecord({ pubkey: STUB_PUBKEY, sign: stubSign });
  await reg.store(record);
  const resolved = await reg.resolve(record.cid);
  assert(resolved !== null, 'should resolve stored record');
  assertEqual(resolved!.cid, record.cid, 'resolved CID should match');
});

test('InMemoryCIDRegistry: resolve returns null for unknown CID', async () => {
  const reg    = new InMemoryCIDRegistry();
  const result = await reg.resolve('cid:iam:doesnotexist');
  assertEqual(result, null, 'unknown CID should return null');
});

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`  Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
if (errors.length > 0) {
  console.log('\n  Failed tests:');
  errors.forEach(e => console.log(`    ✗ ${e}`));
}
console.log(`${'─'.repeat(60)}\n`);

if (failed > 0) process.exit(1);
