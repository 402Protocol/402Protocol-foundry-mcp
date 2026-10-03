/**
 * Foundry safety-wrapper tests.
 *
 *   npx tsx test/foundry.test.ts
 *
 * Covers: FoundryDb roundtrips (approvals lifecycle, launches), the ERC-8004
 * identity gate (missing id rejected), the approval lifecycle
 * request→pending→approve→executed with a mock executor, the reject path
 * (executor never called), double-decision rejection, prepare_launch forcing
 * dryRun:true, the default executor refusing without HOOKIT_PRIVATE_KEY,
 * passthrough tool routing, the "max" send warning, and launch-row
 * reputation writes (erc8004 id + tx hash recorded).
 *
 * No network, no keys, nothing signed or broadcast. Deterministic.
 */
import assert from 'node:assert/strict';
import { FoundryDb } from '../src/db.js';
import {
  createFoundryService,
  defaultHookitExecutor,
  type HookitExecutor,
} from '../src/service.js';
import { toLaunchParams } from '../src/server.js';

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** Mock executor: records calls, returns canned launcher results. */
function mockExecutor() {
  const calls: { tool: string; params: Record<string, unknown> }[] = [];
  const fn: HookitExecutor = async (tool, params) => {
    calls.push({ tool, params });
    if (tool === 'launch_token') {
      return { ok: true, launchId: '7', txHash: `0x${'ab'.repeat(32)}` };
    }
    if (tool === 'claim_fees') return { ok: true, claimed: '1.5' };
    if (tool === 'send_eth') return { ok: true, txHash: `0x${'cd'.repeat(32)}` };
    return { ok: true, tool };
  };
  return { fn, calls };
}

const NOW = 1_800_000_000;
function svcWith(db: FoundryDb, mock = mockExecutor()) {
  const svc = createFoundryService({ db, executor: mock.fn, now: () => NOW });
  return { svc, mock };
}

function launchArgs(over: Record<string, unknown> = {}) {
  return {
    erc8004Id: '4076',
    name: 'Test Coin',
    symbol: 'TST',
    pair: 'eth',
    preset: 'floor',
    hookTaxPct: 5,
    devBuyPct: 1,
    snipeTaxPct: 90,
    ...over,
  };
}

// ---------- db ----------

await check('db: approvals insert → pending → status flips → filtered list', () => {
  const db = new FoundryDb(':memory:');
  db.insertApproval({
    id: 'appr_1', kind: 'launch', erc8004Id: '4076',
    paramsJson: '{}', summary: 's', createdAt: NOW,
  });
  const row = db.getApproval('appr_1')!;
  assert.equal(row.status, 'pending');
  assert.equal(row.erc8004_id, '4076');
  assert.equal(row.decided_at, null);

  db.setApprovalStatus('appr_1', 'rejected', NOW + 10);
  const after = db.getApproval('appr_1')!;
  assert.equal(after.status, 'rejected');
  assert.equal(after.decided_at, NOW + 10);
  assert.equal(db.listApprovals('rejected').length, 1);
  assert.equal(db.listApprovals('pending').length, 0);
  assert.equal(db.listApprovals().length, 1);
  assert.equal(db.getApproval('nope'), null);
  assert.throws(() => db.setApprovalStatus('nope', 'rejected', NOW), /not found/);
  db.close();
});

await check('db: launches insert → list all + by erc8004 id', () => {
  const db = new FoundryDb(':memory:');
  db.insertLaunch({
    id: 'lnch_1', erc8004Id: '4076', tokenName: 'Test Coin', tokenSymbol: 'TST',
    preset: 'floor', modulesJson: JSON.stringify(['backed-floor']), pair: 'eth',
    snipeTaxPct: 90, hookTaxPct: 5, devBuyPct: 1,
    launchTx: `0x${'ab'.repeat(32)}`, launchedAt: NOW,
  });
  db.insertLaunch({
    id: 'lnch_2', erc8004Id: '9999', tokenName: 'Other', tokenSymbol: 'OTH',
    preset: null, modulesJson: null, pair: 'usdg',
    snipeTaxPct: null, hookTaxPct: null, devBuyPct: null,
    launchTx: null, launchedAt: NOW + 1,
  });
  assert.equal(db.listLaunches().length, 2);
  const mine = db.listLaunches('4076');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].token_symbol, 'TST');
  assert.equal(mine[0].launch_tx, `0x${'ab'.repeat(32)}`);
  db.close();
});

// ---------- identity gate ----------

await check('gate: request_launch without erc8004Id is rejected', () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  assert.throws(
    () => svc.requestLaunch({ ...launchArgs(), erc8004Id: '' }),
    /erc8004Id is required/,
  );
  assert.throws(
    () => svc.requestClaimFees({ erc8004Id: '' }),
    /erc8004Id is required/,
  );
  assert.throws(
    () => svc.requestSendEth({ erc8004Id: 'abc', to: `0x${'11'.repeat(20)}`, amount: '0.1' }),
    /erc8004Id is required/,
  );
  // nothing was recorded
  assert.equal(db.listApprovals().length, 0);
  db.close();
});

// ---------- request path ----------

await check('request_launch writes a pending row with summary + identity', () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  const rec = svc.requestLaunch(launchArgs());
  assert.ok(rec.id.startsWith('appr_'));
  assert.equal(rec.status, 'pending');
  assert.equal(rec.erc8004Id, '4076');
  assert.equal(rec.kind, 'launch');
  assert.equal(rec.createdAt, NOW);
  assert.equal(rec.decidedAt, null);
  assert.ok(rec.summary.includes('Test Coin'));
  assert.ok(rec.summary.includes('TST'));
  assert.ok(rec.summary.includes('4076'));
  assert.ok(rec.summary.includes('DISCLOSED'));
  // the identity lives in its own column, not smuggled inside params
  assert.ok(!('erc8004Id' in rec.params));
  const listed = svc.listApprovals('pending');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, rec.id);
  db.close();
});

await check('request_claim_fees + request_send_eth write pending rows', () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  const c = svc.requestClaimFees({ erc8004Id: '4076' });
  assert.equal(c.kind, 'claim_fees');
  assert.equal(c.status, 'pending');
  const s = svc.requestSendEth({
    erc8004Id: '4076',
    to: `0x${'22'.repeat(20)}`,
    amount: '0.05',
  });
  assert.equal(s.kind, 'send_eth');
  assert.equal(s.status, 'pending');
  assert.ok(s.summary.includes('0.05 ETH'));
  assert.throws(
    () => svc.requestSendEth({ erc8004Id: '4076', to: 'not-an-address', amount: '0.1' }),
    /to must be a 0x EVM address/,
  );
  db.close();
});

await check('request_send_eth with "max" warns loudly in the summary', () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  const rec = svc.requestSendEth({
    erc8004Id: '4076',
    to: `0x${'33'.repeat(20)}`,
    amount: 'max',
  });
  assert.ok(rec.summary.includes('WARNING'));
  assert.ok(rec.summary.includes('drains'));
  db.close();
});

await check('request_launch validates launch params up front', () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  assert.throws(() => svc.requestLaunch(launchArgs({ symbol: 'WAYTOOLONGNAME' })), /symbol/);
  assert.throws(() => svc.requestLaunch(launchArgs({ devBuyPct: 5 })), /devBuyPct/);
  assert.throws(() => svc.requestLaunch(launchArgs({ name: '' })), /name/);
  db.close();
});

// ---------- approve / reject lifecycle ----------

await check('approve(launch): executes via executor, writes reputation row', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  const rec = svc.requestLaunch(launchArgs());
  const { approval, result } = await svc.approve(rec.id);

  assert.equal(approval.status, 'executed');
  assert.equal(approval.decidedAt, NOW);
  // exactly one underlying call: launch_token, real execution (no dryRun key)
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].tool, 'launch_token');
  assert.ok(!('dryRun' in mock.calls[0].params), 'approved launch must not carry dryRun');
  assert.equal(mock.calls[0].params.name, 'Test Coin');

  // reputation: the launch is recorded against the ERC-8004 identity
  const launches = svc.listLaunches('4076');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].tokenName, 'Test Coin');
  assert.equal(launches[0].tokenSymbol, 'TST');
  assert.equal(launches[0].erc8004Id, '4076');
  assert.equal(launches[0].preset, 'floor');
  assert.equal(launches[0].hookTaxPct, 5);
  assert.equal(launches[0].snipeTaxPct, 90);
  assert.equal(launches[0].launchTx, `0x${'ab'.repeat(32)}`);
  assert.ok(result !== null);
  db.close();
});

await check('approve(claim_fees): calls claim_fees, no launch row', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  const rec = svc.requestClaimFees({ erc8004Id: '4076' });
  const { approval } = await svc.approve(rec.id);
  assert.equal(approval.status, 'executed');
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].tool, 'claim_fees');
  assert.equal(svc.listLaunches().length, 0);
  db.close();
});

await check('approve(send_eth): calls send_eth with to + amount', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  const to = `0x${'44'.repeat(20)}`;
  const rec = svc.requestSendEth({ erc8004Id: '4076', to, amount: '0.05' });
  await svc.approve(rec.id);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].tool, 'send_eth');
  assert.deepEqual(mock.calls[0].params, { to, amount: '0.05' });
  db.close();
});

await check('approve: executor failure flips the row to failed', async () => {
  const db = new FoundryDb(':memory:');
  const failing: HookitExecutor = async () => {
    throw new Error('launcher exploded');
  };
  const svc = createFoundryService({ db, executor: failing, now: () => NOW });
  const rec = svc.requestLaunch(launchArgs());
  await assert.rejects(svc.approve(rec.id), /launcher exploded/);
  assert.equal(svc.getApproval(rec.id)!.status, 'failed');
  assert.equal(svc.listLaunches().length, 0);
  db.close();
});

await check('reject: flips to rejected, executor never called', () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  const rec = svc.requestLaunch(launchArgs());
  const out = svc.reject(rec.id);
  assert.equal(out.status, 'rejected');
  assert.equal(mock.calls.length, 0);
  assert.equal(svc.listLaunches().length, 0);
  db.close();
});

await check('decisions are single-shot: no double approve/reject', async () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  const a = svc.requestLaunch(launchArgs());
  await svc.approve(a.id);
  await assert.rejects(svc.approve(a.id), /already executed/);
  assert.throws(() => svc.reject(a.id), /already executed/);
  const b = svc.requestClaimFees({ erc8004Id: '4076' });
  svc.reject(b.id);
  assert.throws(() => svc.reject(b.id), /already rejected/);
  await assert.rejects(svc.approve(b.id), /already rejected/);
  await assert.rejects(svc.approve('appr_missing'), /not found/);
  assert.throws(() => svc.reject('appr_missing'), /not found/);
  db.close();
});

// ---------- dryRun discipline ----------

await check('prepare_launch forces dryRun:true on the underlying call', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  await svc.prepareLaunch({
    name: 'Dry Coin', symbol: 'DRY', pair: 'eth', preset: 'clean',
  });
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].tool, 'launch_token');
  assert.equal(mock.calls[0].params.dryRun, true);
  assert.equal(mock.calls[0].params.name, 'Dry Coin');
  // a dry run writes no approval and no launch record
  assert.equal(db.listApprovals().length, 0);
  assert.equal(db.listLaunches().length, 0);
  db.close();
});

// ---------- passthrough routing ----------

await check('passthrough tools route to the right underlying tools', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  await svc.listPresets();
  await svc.listModules();
  await svc.listPairs();
  await svc.walletStatus();
  assert.deepEqual(
    mock.calls.map((c) => c.tool),
    ['list_presets', 'list_modules', 'list_pairs', 'wallet_status'],
  );
  for (const c of mock.calls) assert.deepEqual(c.params, {});
  db.close();
});

// ---------- default executor guard ----------

await check('default executor refuses without HOOKIT_PRIVATE_KEY', async () => {
  const saved = process.env.HOOKIT_PRIVATE_KEY;
  delete process.env.HOOKIT_PRIVATE_KEY;
  try {
    await assert.rejects(
      defaultHookitExecutor('list_presets', {}),
      /HOOKIT_PRIVATE_KEY is not set/,
    );
  } finally {
    if (saved !== undefined) process.env.HOOKIT_PRIVATE_KEY = saved;
  }
});

await check('ticker is accepted as an alias for symbol', () => {
  const p = toLaunchParams({ name: 'Coin', ticker: 'TST', pair: 'eth', erc8004Id: '4076' });
  assert.equal(p.symbol, 'TST');
  assert.ok(!('ticker' in p));
  assert.ok(!('erc8004Id' in p));
  const explicit = toLaunchParams({ name: 'Coin', symbol: 'AAA', ticker: 'BBB', pair: 'eth' });
  assert.equal(explicit.symbol, 'AAA'); // explicit symbol wins
});

console.log(`\n${passed} foundry checks passed`);
