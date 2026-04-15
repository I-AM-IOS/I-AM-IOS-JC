#!/usr/bin/env node
// sovereign-net smoke test — node test-kernel.js
(async () => {
  const { webcrypto } = await import('node:crypto');
  if (!globalThis.crypto) globalThis.crypto = webcrypto;

  let bridge;
  try { bridge = await import('./sovereign-ledger-bridge.js'); }
  catch(e) { console.error('\n  [FAIL] Cannot load sovereign-ledger-bridge.js:', e.message,'\n'); process.exit(1); }

  const { LockedKernelBridge, RejectionReason } = bridge;

  console.log('\n  ══════════════════════════════════════════');
  console.log('   Sovereign Kernel Bridge — smoke test');
  console.log('  ══════════════════════════════════════════\n');

  let pass = 0, fail = 0;
  async function test(name, fn) {
    try { await fn(); console.log(`  ✓  ${name}`); pass++; }
    catch(e) { console.log(`  ✗  ${name}: ${e.message}`); fail++; }
  }

  const rec = (type, seq) => ({
    type, seq, ts: Date.now(),
    hash: Math.random().toString(16).slice(2),
    prevHash: '0000', payload: { v: 1 },
  });

  await test('adaptRecord produces valid envelope', async () => {
    const e = await bridge.adaptRecord(rec('KERNEL_ANALYSIS', 0));
    if (e.protocolVersion !== 1)  throw new Error('wrong protocolVersion');
    if (!e.id || !e.hash)         throw new Error('missing id or hash');
  });

  await test('verifyEvent rejects stale timestamp', async () => {
    const r = { ...rec('KERNEL_ANALYSIS', 1), ts: Date.now() - 200_000 };
    const e = await bridge.adaptRecord(r); e.ts = r.ts;
    const result = await bridge.verifyEvent(e);
    if (result.valid) throw new Error('should reject stale ts');
  });

  await test('LockedKernelBridge accepts valid record', async () => {
    const kernel = new LockedKernelBridge();
    const result = await kernel.ingestRecord(rec('FLOW_COMPILED', 0));
    if (!result.accepted) throw new Error('rejected: ' + result.rejection?.reason);
    if (kernel.height !== 1) throw new Error('height should be 1');
  });

  await test('LockedKernelBridge rejects duplicate', async () => {
    const kernel = new LockedKernelBridge();
    const r = rec('FLOW_COMPILED', 0);
    await kernel.ingestRecord(r);
    const r2 = await kernel.ingestRecord(r);
    if (r2.accepted) throw new Error('should reject duplicate');
    if (r2.reason !== RejectionReason.DUPLICATE) throw new Error('wrong reason: ' + r2.reason);
  });

  await test('Transition chain is valid after 3 records', async () => {
    const kernel = new LockedKernelBridge();
    await kernel.ingestRecord(rec('KERNEL_ANALYSIS', 0));
    await kernel.ingestRecord(rec('FLOW_COMPILED', 1));
    await kernel.ingestRecord(rec('APP_BUILT', 2));
    const { valid } = await kernel.verifyIntegrity();
    if (!valid) throw new Error('chain verification failed');
  });

  await test('exportLedger height and entry count match', async () => {
    const kernel = new LockedKernelBridge();
    await kernel.ingestRecord(rec('KERNEL_ANALYSIS', 0));
    await kernel.ingestRecord(rec('FLOW_COMPILED', 1));
    const { height, ledger, transitions } = kernel.exportLedger();
    if (height !== 2)         throw new Error(`height=${height}`);
    if (ledger.length !== 2)  throw new Error(`ledger len=${ledger.length}`);
    if (transitions.length !== 2) throw new Error(`transitions=${transitions.length}`);
  });

  console.log(`\n  ──────────────────────────────────────────`);
  console.log(`   ${pass} passed · ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
