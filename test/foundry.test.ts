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
 *
 * 0.2.0 additions: hookit-mcp 0.2.0 tool surface (agent pass, list_coins,
 * coin_info, buy/sell, floor redeem/borrow/repay), the payout string→object
 * mapping, modules as a settings object, pairs for multi-pair launches, and
 * snipeTaxPct kept as disclosure metadata (stripped from the wire).
 */
import assert from 'node:assert/strict';
import { FoundryDb } from '../src/db.js';
import {
  createFoundryService,
  defaultHookitExecutor,
  normalizePayoutTarget,
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

/** Hookit-shaped MCP tool result: JSON payload inside content[].text. */
function hookitResult(payload: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Mock executor: records calls, returns canned launcher results. */
function mockExecutor() {
  const calls: { tool: string; params: Record<string, unknown> }[] = [];
  const fn: HookitExecutor = async (tool, params) => {
    calls.push({ tool, params });
    if (tool === 'wallet_status') {
      return hookitResult({
        address: '0xWallet', chain: 'Ink (57073)',
        balanceEth: '0.01', roughCostEth: '0.002', ready: true,
      });
    }
    if (tool === 'launch_token') {
      if (params.dryRun) return hookitResult({ dryRun: true, verdict: 'The launch is valid.' });
      return { ok: true, launchId: '7', txHash: `0x${'ab'.repeat(32)}` };
    }
    if (tool === 'claim_fees') return { ok: true, claimed: '1.5' };
    if (tool === 'send_eth') return { ok: true, txHash: `0x${'cd'.repeat(32)}` };
    return { ok: true, tool };
  };
  return { fn, calls };
}

/** Pre-flight passes: funded wallet + clean simulation. Real launch still fails. */
function mockPreflightOk(inner: HookitExecutor): HookitExecutor {
  return async (tool, params) => {
    if (tool === 'wallet_status') {
      return hookitResult({
        address: '0xWallet', balanceEth: '0.01', roughCostEth: '0.002', ready: true,
      });
    }
    if (tool === 'launch_token' && params.dryRun) {
      return hookitResult({ dryRun: true, verdict: 'The launch is valid.' });
    }
    return inner(tool, params);
  };
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
    tokenAddress: `0x${'11'.repeat(20)}`, preset: 'floor', modulesJson: JSON.stringify(['backed-floor']), pair: 'eth',
    snipeTaxPct: 90, hookTaxPct: 5, devBuyPct: 1, evolveJson: null,
    launchTx: `0x${'ab'.repeat(32)}`, feeTx: `0x${'cd'.repeat(32)}`, launchedAt: NOW,
  });
  db.insertLaunch({
    id: 'lnch_2', erc8004Id: '9999', tokenName: 'Other', tokenSymbol: 'OTH',
    tokenAddress: null, preset: null, modulesJson: null, pair: 'usdg',
    snipeTaxPct: null, hookTaxPct: null, devBuyPct: null, evolveJson: JSON.stringify({ feePct: 1, maxFeePct: 9 }),
    launchTx: null, feeTx: null, launchedAt: NOW + 1,
  });
  assert.equal(db.listLaunches().length, 2);
  const mine = db.listLaunches('4076');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].token_symbol, 'TST');
  assert.equal(mine[0].launch_tx, `0x${'ab'.repeat(32)}`);
  assert.equal(mine[0].fee_tx, `0x${'cd'.repeat(32)}`);
  assert.equal(mine[0].evolve_json, null);
  const other = db.listLaunches('9999');
  assert.equal(other[0].evolve_json, JSON.stringify({ feePct: 1, maxFeePct: 9 }));
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
  // four underlying calls: pre-flight wallet_status + dryRun simulation,
  // then the real launch, then the 0.001 ETH platform fee (fee-after-launch)
  assert.equal(mock.calls.length, 4);
  assert.equal(mock.calls[0].tool, 'wallet_status');
  assert.equal(mock.calls[1].tool, 'launch_token');
  assert.equal(mock.calls[1].params.dryRun, true);
  assert.equal(mock.calls[2].tool, 'launch_token');
  assert.ok(!('dryRun' in mock.calls[2].params), 'approved launch must not carry dryRun');
  assert.equal(mock.calls[2].params.name, 'Test Coin');
  assert.equal(mock.calls[3].tool, 'send_eth');
  assert.deepEqual(mock.calls[3].params, {
    to: '0xaA4E163dA1545F6967d284C0C5CFA469C644eD23',
    amountEth: '0.001', // hookit-mcp's param name, not `amount`
  });

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
  assert.equal(launches[0].feeTx, `0x${'cd'.repeat(32)}`);
  assert.equal(approval.feeTx, `0x${'cd'.repeat(32)}`);
  assert.ok(result !== null);
  db.close();
});

await check('approve(launch): launch failure collects no fee', async () => {
  const db = new FoundryDb(':memory:');
  const calls: string[] = [];
  const launchFails = mockPreflightOk(async (tool, params) => {
    calls.push(tool);
    if (tool === 'launch_token' && !params.dryRun) throw new Error('launch broadcast reverted');
    throw new Error(`must not be called: ${tool}`);
  });
  const svc = createFoundryService({ db, executor: launchFails, now: () => NOW });
  const rec = svc.requestLaunch(launchArgs());
  await assert.rejects(svc.approve(rec.id), /launch broadcast reverted.*No fee was collected/s);
  assert.equal(svc.getApproval(rec.id)!.status, 'failed');
  assert.ok(!calls.includes('send_eth'), 'a failed launch must never touch the fee');
  assert.equal(svc.getApproval(rec.id)!.feeTx, null);
  assert.equal(svc.listLaunches().length, 0);
  db.close();
});

await check('approve(launch): launch success + fee failure surfaces the unpaid fee', async () => {
  const db = new FoundryDb(':memory:');
  const feeFails = mockPreflightOk(async (tool, params) => {
    if (tool === 'launch_token' && !params.dryRun) {
      return hookitResult({ launched: true, token: `0x${'11'.repeat(20)}`, tx: `https://explorer.inkonchain.com/tx/0x${'ab'.repeat(32)}` });
    }
    if (tool === 'send_eth') throw new Error('fee send ran out of gas');
    throw new Error(`must not be called: ${tool}`);
  });
  const svc = createFoundryService({ db, executor: feeFails, now: () => NOW });
  const rec = svc.requestLaunch(launchArgs());
  const { approval, feeTx, feeWarning } = await svc.approve(rec.id);
  // the launch stands: status executed, row recorded, fee marked unpaid
  assert.equal(approval.status, 'executed');
  assert.equal(feeTx, null);
  assert.match(feeWarning ?? '', /fee is still due to the 402 treasury/);
  const launches = svc.listLaunches('4076');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].feeTx, null);
  assert.equal(launches[0].tokenAddress, `0x${'11'.repeat(20)}`);
  db.close();
});

await check('approve(launch): pre-flight blocks an underfunded wallet before the fee moves', async () => {
  const db = new FoundryDb(':memory:');
  const calls: string[] = [];
  const broke: HookitExecutor = async (tool, params) => {
    calls.push(tool);
    if (tool === 'wallet_status') {
      return hookitResult({ address: '0xWallet', balanceEth: '0.0004', roughCostEth: '0.002', ready: false });
    }
    if (tool === 'launch_token' && params.dryRun) {
      return hookitResult({ dryRun: true, verdict: 'The launch is valid.' });
    }
    throw new Error(`must not be called: ${tool}`);
  };
  const svc = createFoundryService({ db, executor: broke, now: () => NOW });
  const rec = svc.requestLaunch(launchArgs());
  await assert.rejects(svc.approve(rec.id), /holds 0.0004 ETH but needs/);
  assert.equal(svc.getApproval(rec.id)!.status, 'failed');
  assert.ok(!calls.includes('send_eth'), 'fee must never move on a doomed launch');
  assert.ok(!calls.includes('launch_token'), 'no launch attempt on a doomed pre-flight');
  assert.equal(svc.listLaunches().length, 0);
  db.close();
});

await check('approve(launch): pre-flight blocks a failing simulation before the fee moves', async () => {
  const db = new FoundryDb(':memory:');
  const calls: string[] = [];
  const badSim: HookitExecutor = async (tool, params) => {
    calls.push(tool);
    if (tool === 'wallet_status') {
      return hookitResult({ address: '0xWallet', balanceEth: '0.01', roughCostEth: '0.002', ready: true });
    }
    if (tool === 'launch_token' && params.dryRun) {
      return hookitResult({ dryRun: true, verdict: 'The launch would fail: duplicate symbol' }, true);
    }
    throw new Error(`must not be called: ${tool}`);
  };
  const svc = createFoundryService({ db, executor: badSim, now: () => NOW });
  const rec = svc.requestLaunch(launchArgs());
  await assert.rejects(svc.approve(rec.id), /would fail: duplicate symbol/);
  assert.equal(svc.getApproval(rec.id)!.status, 'failed');
  assert.ok(!calls.includes('send_eth'), 'fee must never move on a doomed launch');
  assert.equal(svc.listLaunches().length, 0);
  db.close();
});

await check('approve(launch): fee tx extracted from real hookit-mcp result shape', async () => {
  const db = new FoundryDb(':memory:');
  const feeHash = `0x${'ee'.repeat(32)}`;
  const hookitShaped = mockPreflightOk(async (tool, params) => {
    if (tool === 'send_eth') {
      // exactly what hookit-mcp's send_eth returns: JSON-in-string + explorer URL
      return hookitResult({ sentEth: '0.001', to: '0xtreasury', tx: `https://explorer.inkonchain.com/tx/${feeHash}` });
    }
    if (tool === 'launch_token' && !params.dryRun) {
      const launchHash = `0x${'ff'.repeat(32)}`;
      return hookitResult({ launched: true, tx: `https://explorer.inkonchain.com/tx/${launchHash}` });
    }
    throw new Error(`unexpected: ${tool}`);
  });
  const svc = createFoundryService({ db, executor: hookitShaped, now: () => NOW });
  const rec = svc.requestLaunch(launchArgs());
  const { approval } = await svc.approve(rec.id);
  assert.equal(approval.status, 'executed');
  assert.equal(approval.feeTx, feeHash);
  const launches = svc.listLaunches('4076');
  assert.equal(launches[0].feeTx, feeHash);
  assert.equal(launches[0].launchTx, `0x${'ff'.repeat(32)}`);
  db.close();
});

await check('requestLaunch rejects hookTaxPct above hookit range (0-9)', async () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  assert.throws(() => svc.requestLaunch(launchArgs({ hookTaxPct: 10 })), /between 0 and 9/);
  assert.throws(() => svc.requestLaunch(launchArgs({ hookTaxPct: 50 })), /between 0 and 9/);
  // 9 is still fine
  svc.requestLaunch(launchArgs({ hookTaxPct: 9 }));
  db.close();
});

await check('requestLaunch summary discloses the platform fee', async () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  const rec = svc.requestLaunch(launchArgs());
  assert.match(rec.summary, /0\.001 ETH Foundry fee/);
  assert.match(rec.summary, /402 treasury/);
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
  assert.deepEqual(mock.calls[0].params, { to, amountEth: '0.05' }); // translated for hookit-mcp
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

await check('prepare_launch always attaches the anti-snipe warning', async () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  const out = await svc.prepareLaunch({
    name: 'Dry Coin', symbol: 'DRY', pair: 'eth', preset: 'clean',
  });
  assert.ok(Array.isArray(out.warnings) && out.warnings.length === 1);
  assert.match(out.warnings[0]!, /anti-snipe tax/);
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

// ---------- 0.2.0: payout mapping ----------

await check('normalizePayoutTarget: 0x → wallet, @handle → x, garbage throws', () => {
  const addr = `0x${'55'.repeat(20)}`;
  assert.deepEqual(normalizePayoutTarget(addr), { kind: 'wallet', address: addr });
  assert.deepEqual(normalizePayoutTarget('@somehandle'), { kind: 'x', handle: 'somehandle' });
  assert.deepEqual(normalizePayoutTarget('somehandle'), { kind: 'x', handle: 'somehandle' });
  assert.equal(normalizePayoutTarget(undefined), undefined);
  assert.deepEqual(
    normalizePayoutTarget({ kind: 'wallet', address: addr }),
    { kind: 'wallet', address: addr },
  );
  assert.throws(() => normalizePayoutTarget('not a target!!!'), /payout must be/);
  assert.throws(() => normalizePayoutTarget({ kind: 'bogus' }), /payout.kind must be/);
});

// ---------- 0.2.0: modules object + pairs + snipeTaxPct discipline ----------

await check('prepare_launch: modules object + pairs forwarded, snipeTaxPct stripped, payout mapped', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  const addr = `0x${'66'.repeat(20)}`;
  await svc.prepareLaunch({
    name: 'Mod Coin', symbol: 'MOD', pair: 'eth', pairs: ['usdg', 'wnvdax'],
    preset: 'dynamic', modules: { maxTx: true, maxTxBps: 100 },
    snipeTaxPct: 90, payout: addr,
  });
  assert.equal(mock.calls.length, 1);
  const params = mock.calls[0].params;
  assert.equal(params.dryRun, true);
  assert.deepEqual(params.modules, { maxTx: true, maxTxBps: 100 });
  assert.deepEqual(params.pairs, ['usdg', 'wnvdax']);
  assert.ok(!('snipeTaxPct' in params), 'disclosure metadata never goes over the wire');
  assert.deepEqual(params.payout, { kind: 'wallet', address: addr });
  db.close();
});

await check('prepare_launch rejects an array-shaped modules', async () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  await assert.rejects(
    svc.prepareLaunch({ name: 'Bad', symbol: 'BAD', pair: 'eth', modules: ["maxTx"] as never }),
    /modules must be a settings object/,
  );
  db.close();
});

// ---------- 0.2.0: new passthrough routing ----------

await check('passthrough: list_coins / coin_info / agent_pass_challenge route correctly', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  await svc.listCoins({ sort: 'gainers', filter: 'ai_agents_only', limit: 10 });
  await svc.coinInfo(`0x${'77'.repeat(20)}`);
  await svc.agentPassChallenge();
  await svc.agentPassChallenge('4076');
  assert.deepEqual(
    mock.calls.map((c) => c.tool),
    ['list_coins', 'coin_info', 'agent_pass_challenge', 'agent_pass_challenge'],
  );
  assert.deepEqual(mock.calls[0].params, { sort: 'gainers', filter: 'ai_agents_only', limit: 10 });
  assert.deepEqual(mock.calls[1].params, { token: `0x${'77'.repeat(20)}` });
  assert.deepEqual(mock.calls[2].params, {});
  assert.deepEqual(mock.calls[3].params, { agentId: '4076' });
  assert.throws(() => svc.coinInfo('not-an-address'), /token must be a 0x coin address/);
  assert.throws(() => svc.listCoins({ limit: 99 }), /limit must be an integer 1-50/);
  db.close();
});

// ---------- 0.2.0: identity gate on the new request tools ----------

await check('gate: new request_* tools require erc8004Id', () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  const token = `0x${'88'.repeat(20)}`;
  assert.throws(() => svc.requestClaimAgentPass({ erc8004Id: '', challengeId: 'ch', answers: ['a'] }), /erc8004Id is required/);
  assert.throws(() => svc.requestBuyToken({ erc8004Id: 'x', token, amount: '0.01' }), /erc8004Id is required/);
  assert.throws(() => svc.requestSellToken({ erc8004Id: '', token, amount: 'max' }), /erc8004Id is required/);
  assert.throws(() => svc.requestRedeemFloor({ erc8004Id: '', token, amount: '10' }), /erc8004Id is required/);
  assert.throws(() => svc.requestBorrowFloor({ erc8004Id: '', token, amount: '10' }), /erc8004Id is required/);
  assert.throws(() => svc.requestRepayLoan({ erc8004Id: '' }), /erc8004Id is required/);
  db.close();
});

// ---------- 0.2.0: new gated flows ----------

await check('approve(claim_agent_pass): challengeId→id, erc8004Id→agentId', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  const rec = svc.requestClaimAgentPass({
    erc8004Id: '4076', challengeId: 'ch_1', answers: ['seven', 42],
  });
  assert.equal(rec.status, 'pending');
  assert.match(rec.summary, /ERC-8004 validation/);
  const { approval } = await svc.approve(rec.id);
  assert.equal(approval.status, 'executed');
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].tool, 'claim_agent_pass');
  assert.deepEqual(mock.calls[0].params, { id: 'ch_1', answers: ['seven', 42], agentId: '4076' });
  assert.equal(svc.listLaunches().length, 0);
  db.close();
});

await check('requestBuyToken validation: bad token, bad slippage', () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  assert.throws(() => svc.requestBuyToken({ erc8004Id: '4076', token: 'nope', amount: '0.01' }), /token must be a 0x coin address/);
  assert.throws(
    () => svc.requestBuyToken({ erc8004Id: '4076', token: `0x${'88'.repeat(20)}`, amount: '0.01', slippageBps: 99999 }),
    /slippageBps must be an integer between 1 and 5000/,
  );
  assert.throws(
    () => svc.requestBorrowFloor({ erc8004Id: '4076', token: `0x${'88'.repeat(20)}`, amount: '10', days: 45 }),
    /days must be one of/,
  );
  db.close();
});

await check('approve(buy_token): exact params, no launch row', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  const token = `0x${'99'.repeat(20)}`;
  const rec = svc.requestBuyToken({
    erc8004Id: '4076', token, amount: '0.01', payWith: 'usdg', slippageBps: 100,
  });
  assert.match(rec.summary, /0\.01/);
  const { approval } = await svc.approve(rec.id);
  assert.equal(approval.status, 'executed');
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].tool, 'buy_token');
  assert.deepEqual(mock.calls[0].params, { token, amount: '0.01', payWith: 'usdg', slippageBps: 100 });
  assert.equal(svc.listLaunches().length, 0);
  db.close();
});

await check('approve routes sell/redeem/borrow/repay to the right tools', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  const token = `0x${'aa'.repeat(20)}`;
  const s = await svc.approve(svc.requestSellToken({ erc8004Id: '4076', token, amount: 'max' }).id);
  const r = await svc.approve(svc.requestRedeemFloor({ erc8004Id: '4076', token, amount: '50%' }).id);
  const b = await svc.approve(svc.requestBorrowFloor({ erc8004Id: '4076', token, amount: '1000', days: 14 }).id);
  const p = await svc.approve(svc.requestRepayLoan({ erc8004Id: '4076' }).id);
  assert.deepEqual(
    mock.calls.map((c) => c.tool),
    ['sell_token', 'redeem_floor', 'borrow_against_floor', 'repay_loan'],
  );
  assert.deepEqual(mock.calls[0].params, { token, amount: 'max' });
  assert.deepEqual(mock.calls[2].params, { token, amount: '1000', days: 14 });
  assert.deepEqual(mock.calls[3].params, {});
  for (const a of [s, r, b, p]) assert.equal(a.approval.status, 'executed');
  db.close();
});

await check('approve(launch): snipeTaxPct stripped from the wire, kept on the row', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  const rec = svc.requestLaunch(launchArgs({ snipeTaxPct: 90 }));
  await svc.approve(rec.id);
  const launchCall = mock.calls.find((c) => c.tool === 'launch_token' && !c.params.dryRun)!;
  assert.ok(!('snipeTaxPct' in launchCall.params), 'disclosure metadata never goes over the wire');
  const row = svc.listLaunches()[0];
  assert.equal(row.snipeTaxPct, 90);
  assert.ok(launchCall.params.dryRun !== true);
  db.close();
});

// ---------- evolve (0.2.2) ----------

function evolveLaunchArgs(over: Record<string, unknown> = {}) {
  return {
    erc8004Id: '4894',
    name: 'Quill',
    symbol: 'QL',
    pair: 'eth',
    modules: { antiMev: true, antiSnipe: true, antiSnipeInitialTax: 98, antiSnipeDuration: 20 },
    devBuyPct: 2.5,
    snipeTaxPct: 98,
    evolve: { feePct: 1, maxFeePct: 9 },
    ...over,
  };
}

await check('evolve: launch validation rejects hookit-forbidden combinations', () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  assert.throws(
    () => svc.requestLaunch({ ...evolveLaunchArgs(), hookTaxPct: 3 } as any),
    /cannot combine with hookTaxPct/,
  );
  assert.throws(
    () => svc.requestLaunch(evolveLaunchArgs({ modules: { dynamicFees: true, dynamicFeeMinBps: 300, dynamicFeeMaxBps: 500 } })),
    /cannot combine with dynamic fees/,
  );
  assert.throws(
    () => svc.requestLaunch(evolveLaunchArgs({ pairs: ['usdg'] })),
    /single-pair only/,
  );
  assert.throws(
    () => svc.requestLaunch(evolveLaunchArgs({ evolve: { feePct: 5, maxFeePct: 3 } })),
    /cannot exceed.*maxFeePct/,
  );
  assert.throws(
    () => svc.requestLaunch(evolveLaunchArgs({ evolve: { maxFeePct: 10 } })),
    /maxFeePct must be between 0 and 9/,
  );
  assert.throws(
    () => svc.requestLaunch(evolveLaunchArgs({ evolve: 'yes' })),
    /must be an object/,
  );
  db.close();
});

await check('evolve: valid launch passes validation, evolve goes over the wire, recorded on the row', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  const { result } = await svc.prepareLaunch(evolveLaunchArgs() as any);
  assert.ok(result, 'dry run returns');
  const dryCall = mock.calls.find((c) => c.tool === 'launch_token' && c.params.dryRun === true)!;
  assert.deepEqual(dryCall.params.evolve, { feePct: 1, maxFeePct: 9 });
  const rec = svc.requestLaunch(evolveLaunchArgs() as any);
  assert.match(rec.summary, /PERMANENT decider/);
  await svc.approve(rec.id);
  const row = svc.listLaunches('4894')[0];
  assert.deepEqual(row.evolve, { feePct: 1, maxFeePct: 9 });
  const liveCall = mock.calls.find((c) => c.tool === 'launch_token' && !c.params.dryRun)!;
  assert.deepEqual(liveCall.params.evolve, { feePct: 1, maxFeePct: 9 });
  db.close();
});

await check('evolve: {} takes hookit defaults', async () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  const rec = svc.requestLaunch(evolveLaunchArgs({ evolve: {} }) as any);
  assert.match(rec.summary, /cap 3%/);
  db.close();
});

await check('evolve_decide: validation (split wholeness, 100 total, creator cap, cancel exclusivity)', () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  const token = `0x${'aa'.repeat(20)}`;
  const base = { erc8004Id: '4894', token };
  assert.throws(() => svc.requestEvolveDecide(base as any), /needs something to move/);
  assert.throws(
    () => svc.requestEvolveDecide({ ...base, burnPct: 50 } as any),
    /moves as a whole/,
  );
  assert.throws(
    () => svc.requestEvolveDecide({ ...base, burnPct: 50, deepenPct: 20, holdersPct: 20, creatorPct: 5 } as any),
    /must total 100/,
  );
  assert.throws(
    () => svc.requestEvolveDecide({ ...base, burnPct: 40, deepenPct: 20, holdersPct: 10, creatorPct: 30 } as any),
    /cannot exceed 20/,
  );
  assert.throws(
    () => svc.requestEvolveDecide({ ...base, cancel: true, feePct: 2 } as any),
    /takes no feePct/,
  );
  assert.throws(
    () => svc.requestEvolveDecide({ ...base, feePct: 10 } as any),
    /feePct must be between 0 and 9/,
  );
  assert.throws(() => svc.requestEvolveDecide({ erc8004Id: '', token } as any), /erc8004Id is required/);
  assert.throws(() => svc.requestEvolveDecide({ erc8004Id: '4894', token: 'nope' } as any), /0x coin address/);
  db.close();
});

await check('evolve_decide: fee-only move and full split route to evolve_decide on approve', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  const token = `0x${'aa'.repeat(20)}`;
  const feeOnly = svc.requestEvolveDecide({ erc8004Id: '4894', token, feePct: 2, reason: 'calm the market' });
  assert.match(feeOnly.summary, /fee to 2%/);
  await svc.approve(feeOnly.id);
  const split = svc.requestEvolveDecide({
    erc8004Id: '4894', token,
    burnPct: 34, deepenPct: 33, holdersPct: 33, creatorPct: 0,
  });
  await svc.approve(split.id);
  const cancel = svc.requestEvolveDecide({ erc8004Id: '4894', token, cancel: true });
  await svc.approve(cancel.id);
  assert.deepEqual(
    mock.calls.map((c) => c.tool),
    ['evolve_decide', 'evolve_decide', 'evolve_decide'],
  );
  assert.deepEqual(mock.calls[0].params, { token, feePct: 2, reason: 'calm the market' });
  assert.deepEqual(mock.calls[1].params, { token, burnPct: 34, deepenPct: 33, holdersPct: 33, creatorPct: 0 });
  assert.deepEqual(mock.calls[2].params, { token, cancel: true });
  db.close();
});

await check('evolve_plug: validation (slot range, mode exclusivity)', () => {
  const db = new FoundryDb(':memory:');
  const { svc } = svcWith(db);
  const token = `0x${'aa'.repeat(20)}`;
  const base = { erc8004Id: '4894', token };
  assert.throws(() => svc.requestEvolvePlug({ ...base, slot: 0, hookId: 1 } as any), /slot must be an integer 1-8/);
  assert.throws(() => svc.requestEvolvePlug({ ...base, slot: 9, hookId: 1 } as any), /slot must be an integer 1-8/);
  assert.throws(() => svc.requestEvolvePlug({ ...base, slot: 1 } as any), /hookId is required/);
  assert.throws(
    () => svc.requestEvolvePlug({ ...base, slot: 1, unplug: true, hookId: 2 } as any),
    /unplug: true takes no hookId/,
  );
  assert.throws(
    () => svc.requestEvolvePlug({ ...base, slot: 1, hookId: 2, sharePct: 101 } as any),
    /sharePct must be between 0 and 100/,
  );
  assert.throws(
    () => svc.requestEvolvePlug({ ...base, slot: 1, hookId: 2, config: 'zzz' } as any),
    /0x ABI-encoded hex/,
  );
  db.close();
});

await check('evolve_plug: plug and unplug route to evolve_plug on approve', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  const token = `0x${'aa'.repeat(20)}`;
  const plug = svc.requestEvolvePlug({ erc8004Id: '4894', token, slot: 1, hookId: 3, sharePct: 30 });
  assert.match(plug.summary, /plug hook 3 into slot 1/);
  await svc.approve(plug.id);
  const unplug = svc.requestEvolvePlug({ erc8004Id: '4894', token, slot: 1, unplug: true });
  await svc.approve(unplug.id);
  assert.deepEqual(mock.calls.map((c) => c.tool), ['evolve_plug', 'evolve_plug']);
  assert.deepEqual(mock.calls[0].params, { token, slot: 1, hookId: 3, sharePct: 30 });
  assert.deepEqual(mock.calls[1].params, { token, slot: 1, unplug: true });
  db.close();
});

await check('evolve: read-only passthroughs route correctly', async () => {
  const db = new FoundryDb(':memory:');
  const { svc, mock } = svcWith(db);
  const token = `0x${'aa'.repeat(20)}`;
  await svc.evolveStatus(token);
  await svc.evolveHooks();
  assert.deepEqual(mock.calls.map((c) => c.tool), ['evolve_status', 'evolve_hooks']);
  assert.deepEqual(mock.calls[0].params, { token });
  assert.deepEqual(mock.calls[1].params, {});
  assert.throws(() => svc.evolveStatus('nope'), /0x coin address/);
  db.close();
});

console.log(`\n${passed} foundry checks passed`);
