/**
 * Foundry service — the safety wrapper around the hookit launch MCP.
 *
 * The underlying launcher signs and broadcasts with zero confirmation gates,
 * so this service never exposes its dangerous tools directly. Instead:
 *
 *   PASSTHROUGH (always safe): list_presets, list_modules, list_pairs,
 *     wallet_status, list_coins, coin_info, agent_pass_challenge, and
 *     prepare_launch — which FORCES dryRun:true on the underlying
 *     launch_token call. These never sign anything.
 *
 *   GATED (never execute directly): request_launch, request_claim_fees,
 *     request_send_eth, request_claim_agent_pass, request_buy_token,
 *     request_sell_token, request_redeem_floor, request_borrow_floor,
 *     request_repay_loan. Each writes a pending row to the approvals table
 *     and returns a plain-words summary of what approving would do. A human
 *     flips the row via approve/reject; only approve() touches the executor.
 *
 *   IDENTITY GATE: every request_* call requires the agent's ERC-8004 id.
 *     No ID, no launch — the permission lives on the identity, so track
 *     records accrue to the agent and can't be laundered through fresh wallets.
 *
 * The underlying invocation goes through an injected HookitExecutor. The
 * default executor shells out to `npx -y hookit-mcp` over MCP stdio and
 * REFUSES to run unless HOOKIT_PRIVATE_KEY is set in the environment.
 * Tests inject a mock. This server never holds a key in code, never accepts
 * one as a tool argument, and never logs one.
 */
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  FoundryDb,
  type ApprovalKind,
  type ApprovalRow,
  type ApprovalStatus,
  type LaunchRow,
} from './db.js';

/** Invoke one tool on the underlying launcher. Injected for tests. */
export type HookitExecutor = (
  tool: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Per-tool timeout for Hookit calls. The Hookit server builds full launch
 * calldata even for dry runs, which routinely exceeds the MCP SDK's 60s
 * default — a dry-run would die with -32001 before the server answered.
 */
export const HOOKIT_TOOL_TIMEOUT_MS = 180_000;

/**
 * Foundry platform fee: flat 0.001 ETH per launch, collected at approve
 * time (before the launch broadcasts) from the launch wallet to the 402
 * treasury. One-time, no volume cut. Both overridable via env.
 */
export const FOUNDRY_FEE_ETH = process.env.FOUNDRY_FEE_ETH ?? '0.001';
export const FOUNDRY_FEE_RECIPIENT =
  process.env.FOUNDRY_FEE_RECIPIENT ?? '0xaA4E163dA1545F6967d284C0C5CFA469C644eD23';

/**
 * Default executor: speaks MCP stdio to a `npx -y hookit-mcp@0.2.0` child
 * process. The version is PINNED: the wrapper is built and tested against
 * hookit-mcp 0.2.0's tool shapes (agent pass, floor redeem/borrow,
 * multi-asset buys). A newer hookit-mcp may change those shapes, so the
 * pin moves deliberately, never by npx drift. Refuses to run when
 * HOOKIT_PRIVATE_KEY is absent — without a key the child cannot sign, and
 * we fail closed instead of half-working.
 */
export async function defaultHookitExecutor(
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!process.env.HOOKIT_PRIVATE_KEY) {
    throw new Error(
      'HOOKIT_PRIVATE_KEY is not set: the hookit executor refuses to run without it. ' +
        'Set it in the environment of the process hosting this server (never in code, chat, or logs).',
    );
  }
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', 'hookit-mcp@0.2.0'],
    env: process.env as Record<string, string>,
  });
  const client = new Client(
    { name: 'foundry-executor', version: '0.2.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    return await client.callTool(
      { name: tool, arguments: params },
      undefined,
      { timeout: HOOKIT_TOOL_TIMEOUT_MS },
    );
  } finally {
    await client.close();
  }
}

const KIND_TO_TOOL: Record<ApprovalKind, string> = {
  launch: 'launch_token',
  claim_fees: 'claim_fees',
  send_eth: 'send_eth',
  claim_agent_pass: 'claim_agent_pass',
  buy_token: 'buy_token',
  sell_token: 'sell_token',
  redeem_floor: 'redeem_floor',
  borrow_floor: 'borrow_against_floor',
  repay_loan: 'repay_loan',
};

/** Creator-fee payout target, hookit-mcp's object shape. */
export interface PayoutTarget {
  kind: 'wallet' | 'x' | 'github' | 'tiktok';
  address?: string;
  handle?: string;
  accountId?: string;
}

/**
 * Accept the friendly forms agents actually type — a 0x wallet address or an
 * @handle — and map them onto hookit-mcp's payout object. Full objects pass
 * through (validated). Exported for tests.
 */
export function normalizePayoutTarget(payout: unknown): PayoutTarget | undefined {
  if (payout === undefined) return undefined;
  if (typeof payout === 'string') {
    const s = payout.trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { kind: 'wallet', address: s };
    const handle = s.replace(/^@/, '');
    if (/^[A-Za-z0-9_]{1,32}$/.test(handle)) return { kind: 'x', handle };
    throw new Error('payout must be a 0x wallet address or an @handle');
  }
  if (typeof payout === 'object' && payout !== null) {
    const o = payout as Record<string, unknown>;
    if (!['wallet', 'x', 'github', 'tiktok'].includes(o.kind as string)) {
      throw new Error('payout.kind must be one of: wallet, x, github, tiktok');
    }
    return o as unknown as PayoutTarget;
  }
  throw new Error('payout must be a 0x wallet address, an @handle, or a target object');
}

export interface LaunchParams {
  name: string;
  symbol: string;
  pair: string;
  /** Extra quote pairs for a multi-pair launch (USDG and stock pairs only). */
  pairs?: string[];
  preset?: string;
  /** Hook module SETTINGS, hookit-mcp's object shape: {"maxTx": true, "maxTxBps": 100}. */
  modules?: Record<string, boolean | number>;
  hookTaxPct?: number;
  devBuyPct?: number;
  /** Disclosure-only: the opening anti-snipe tax % we tell the human about.
   *  hookit-mcp has no such launch param — it is stripped before the
   *  underlying call and kept on the approval/launch rows. */
  snipeTaxPct?: number;
  /** Friendly string ("0x…" / "@handle") or hookit's target object. */
  payout?: string | PayoutTarget;
  description?: string;
  image?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface ApprovalRecord {
  id: string;
  kind: ApprovalKind;
  erc8004Id: string;
  params: Record<string, unknown>;
  summary: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt: number | null;
  /** 0.001 ETH platform fee tx (launch approvals only, once collected). */
  feeTx: string | null;
}

export interface LaunchRecord {
  id: string;
  erc8004Id: string;
  tokenName: string;
  tokenSymbol: string;
  /** Launched token contract address; view it at https://www.hookit.fun/token/<address>. */
  tokenAddress: string | null;
  preset: string | null;
  /** Hook module settings as passed to hookit-mcp, e.g. {"maxTx": true}. */
  modules: Record<string, boolean | number> | null;
  pair: string;
  snipeTaxPct: number | null;
  hookTaxPct: number | null;
  devBuyPct: number | null;
  launchTx: string | null;
  feeTx: string | null;
  launchedAt: number;
}

export interface FoundryServiceOptions {
  db: FoundryDb;
  executor: HookitExecutor;
  /** Override the clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/** The identity gate: every gated action must carry an ERC-8004 agent id. */
function requireErc8004Id(erc8004Id: unknown): string {
  if (typeof erc8004Id !== 'string' || !/^\d+$/.test(erc8004Id)) {
    throw new Error(
      'erc8004Id is required: every Foundry action is bound to an ERC-8004 agent ' +
        'identity (decimal string, e.g. "4076"). No ID, no launch.',
    );
  }
  return erc8004Id;
}

/** A 0x coin address on Ink, or a plain-words rejection. */
function requireTokenAddress(token: unknown): string {
  if (typeof token !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
    throw new Error('token must be a 0x coin address on Ink');
  }
  return token;
}

/** Slippage in basis points, hookit-mcp's 1-5000 range. */
function requireSlippageBps(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 5000) {
    throw new Error('slippageBps must be an integer between 1 and 5000');
  }
  return v as number;
}

function validateLaunchParams(p: LaunchParams): void {
  if (!p.name || p.name.length > 32) throw new Error('name must be 1-32 characters');
  if (!/^[A-Za-z0-9]{1,12}$/.test(p.symbol)) {
    throw new Error('symbol must be 1-12 letters or digits');
  }
  if (!p.pair) throw new Error('pair is required');
  if (p.pairs !== undefined) {
    if (!Array.isArray(p.pairs) || p.pairs.some((x) => typeof x !== 'string' || !x)) {
      throw new Error('pairs must be an array of pair ids (USDG and stock pairs only)');
    }
  }
  if (p.modules !== undefined) {
    if (typeof p.modules !== 'object' || p.modules === null || Array.isArray(p.modules)) {
      throw new Error(
        'modules must be a settings object from foundry_list_modules, e.g. {"maxTx": true, "maxTxBps": 100}',
      );
    }
    for (const [k, v] of Object.entries(p.modules)) {
      if (typeof v !== 'boolean' && typeof v !== 'number') {
        throw new Error(`module setting "${k}" must be true/false or a number`);
      }
    }
  }
  // normalizePayoutTarget throws on anything that is not a valid target.
  normalizePayoutTarget(p.payout);
  if (p.devBuyPct !== undefined && (p.devBuyPct < 0 || p.devBuyPct > 2.5)) {
    throw new Error('devBuyPct must be between 0 and 2.5');
  }
  if (p.hookTaxPct !== undefined && (p.hookTaxPct < 0 || p.hookTaxPct > 9)) {
    throw new Error('hookTaxPct must be between 0 and 9 (hookit range)');
  }
  if (p.snipeTaxPct !== undefined && (p.snipeTaxPct < 0 || p.snipeTaxPct > 100)) {
    throw new Error('snipeTaxPct must be between 0 and 100');
  }
}

/** Best-effort tx-hash extraction from an executor result (shape is launcher-defined).
 * Handles the real hookit-mcp shape —
 *   { content: [{ type: 'text', text: '{"tx":"https://explorer.inkonchain.com/tx/0x…"}' }] }
 * i.e. JSON inside a string plus explorer URLs — as well as bare 0x hashes
 * under tx-ish keys. Without the string/URL handling, real hookit responses
 * always yielded null and successful launches recorded no tx hash. */
function extractTxHash(result: unknown, depth = 0): string | null {
  if (depth > 4 || result === null || result === undefined) return null;
  if (typeof result === 'string') {
    const urlHit = result.match(/\/tx\/(0x[0-9a-fA-F]{64})/);
    if (urlHit) return urlHit[1];
    try {
      return extractTxHash(JSON.parse(result), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(result)) {
    for (const v of result) {
      const hit = extractTxHash(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof result === 'object') {
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      if (/^(txhash|transactionhash|hash|tx)$/i.test(k) && typeof v === 'string') {
        const m = v.match(/(0x[0-9a-fA-F]{64})/);
        if (m) return m[1];
      }
      const hit = extractTxHash(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Pull the payload out of an MCP tool result: { json, isError, text }. */
function toolPayload(result: unknown): { json: any; isError: boolean; text: string } {
  const r = result as { content?: { text?: string }[]; isError?: boolean } | null;
  const text = r?.content?.[0]?.text ?? '';
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain-text failure message — json stays null, text carries it */
  }
  return { json, isError: r?.isError === true, text };
}

/**
 * Pre-flight gates for a launch approval. Run BEFORE the fee moves:
 *  1. wallet_status — the launch wallet must hold the Foundry fee PLUS the
 *     launch cost (hookit launch fee + gas). If not, abort with funding
 *     instructions; no money has moved.
 *  2. launch_token dryRun — hookit simulates the exact params about to be
 *     executed. If the simulation says the launch would fail, abort before
 *     the fee moves.
 * Both gates fail closed: an unverifiable wallet or simulation blocks the
 * launch instead of risking a stranded fee.
 */
async function assertLaunchPreflight(
  executor: HookitExecutor,
  params: Record<string, unknown>,
): Promise<void> {
  let statusJson: any;
  try {
    statusJson = toolPayload(await executor('wallet_status', {})).json;
  } catch (e) {
    throw new Error(
      `Pre-flight balance check failed (${(e as Error).message}). ` +
        `Refusing to move the ${FOUNDRY_FEE_ETH} ETH fee until the wallet can be verified.`,
    );
  }
  const balance = parseFloat(statusJson?.balanceEth);
  const roughCost = parseFloat(statusJson?.roughCostEth);
  if (!Number.isFinite(balance) || !Number.isFinite(roughCost)) {
    throw new Error(
      'Pre-flight balance check returned an unreadable wallet status. ' +
        `Refusing to move the ${FOUNDRY_FEE_ETH} ETH fee until the wallet can be verified.`,
    );
  }
  const needed = parseFloat(FOUNDRY_FEE_ETH) + roughCost;
  if (balance < needed) {
    throw new Error(
      `Launch wallet ${statusJson?.address ?? '(unknown)'} holds ${balance} ETH but needs ` +
        `~${needed.toFixed(4)} ETH (${FOUNDRY_FEE_ETH} Foundry fee + ~${roughCost} launch cost). ` +
        `Fund it with ~${(needed - balance).toFixed(4)} more ETH first — nothing has moved.`,
    );
  }
  let sim: { json: any; isError: boolean; text: string };
  try {
    sim = toolPayload(await executor('launch_token', { ...params, dryRun: true }));
  } catch (e) {
    throw new Error(
      `Pre-flight launch simulation failed (${(e as Error).message}). ` +
        `Refusing to move the ${FOUNDRY_FEE_ETH} ETH fee until the launch simulates cleanly.`,
    );
  }
  if (sim.isError || /would fail/i.test(sim.json?.verdict ?? '') || /would fail/i.test(sim.text)) {
    throw new Error(
      `Pre-flight simulation says this launch would fail: ${sim.json?.verdict ?? sim.text} — nothing has moved.`,
    );
  }
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function createFoundryService(opts: FoundryServiceOptions) {
  const { db, executor } = opts;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  function toApprovalRecord(row: ApprovalRow): ApprovalRecord {
    return {
      id: row.id,
      kind: row.kind,
      erc8004Id: row.erc8004_id,
      params: JSON.parse(row.params_json) as Record<string, unknown>,
      summary: row.summary,
      status: row.status,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      feeTx: row.fee_tx,
    };
  }

  function toLaunchRecord(row: LaunchRow): LaunchRecord {
    return {
      id: row.id,
      erc8004Id: row.erc8004_id,
      tokenName: row.token_name,
      tokenSymbol: row.token_symbol,
      tokenAddress: row.token_address,
      preset: row.preset,
      modules: row.modules_json
        ? (JSON.parse(row.modules_json) as Record<string, boolean | number>)
        : null,
      pair: row.pair,
      snipeTaxPct: row.snipe_tax_pct,
      hookTaxPct: row.hook_tax_pct,
      devBuyPct: row.dev_buy_pct,
      launchTx: row.launch_tx,
      feeTx: row.fee_tx,
      launchedAt: row.launched_at,
    };
  }

  /**
   * Record a reputation entry after an approved launch executes. The row is
   * written BEFORE the fee is collected (feeTx starts null) so a crash
   * between launch and fee can never lose the launch itself. Returns the
   * launch id for the follow-up fee update.
   */
  function recordLaunch(
    approval: ApprovalRow,
    params: LaunchParams,
    result: unknown,
    launchTx: string | null,
    feeTx: string | null,
    ts: number,
  ): string {
    const payload = toolPayload(result);
    const tokenAddress =
      typeof payload.json?.token === 'string' && /^0x[0-9a-fA-F]{40}$/.test(payload.json.token)
        ? payload.json.token
        : null;
    const id = newId('lnch');
    db.insertLaunch({
      id,
      erc8004Id: approval.erc8004_id,
      tokenName: params.name,
      tokenSymbol: params.symbol,
      tokenAddress,
      preset: params.preset ?? null,
      modulesJson: params.modules ? JSON.stringify(params.modules) : null,
      pair: params.pair,
      snipeTaxPct: params.snipeTaxPct ?? null,
      hookTaxPct: params.hookTaxPct ?? null,
      devBuyPct: params.devBuyPct ?? null,
      launchTx,
      feeTx,
      launchedAt: ts,
    });
    return id;
  }

  function storeRequest(
    kind: ApprovalKind,
    erc8004Id: string,
    params: Record<string, unknown>,
    summary: string,
  ): ApprovalRecord {
    const id = newId('appr');
    db.insertApproval({
      id,
      kind,
      erc8004Id,
      paramsJson: JSON.stringify(params),
      summary,
      createdAt: now(),
    });
    return toApprovalRecord(db.getApproval(id)!);
  }

  return {
    // ---- passthrough: always safe, never signs ----

    listPresets: () => executor('list_presets', {}),
    listModules: () => executor('list_modules', {}),
    listPairs: () => executor('list_pairs', {}),
    walletStatus: () => executor('wallet_status', {}),

    /**
     * Browse hookit coins: newest, top market cap, volume, or 24h gainers;
     * filters for AI-agent-only, gated, launched-by-agents, Backed Floor,
     * and Boss Raid coins, a pair, or a name search. Read-only.
     */
    listCoins: (p: {
      sort?: 'new' | 'marketcap' | 'volume' | 'gainers';
      filter?: 'all' | 'ai_agents_only' | 'gated' | 'launched_by_agents' | 'backed_floor' | 'boss_raid';
      pair?: string;
      search?: string;
      limit?: number;
    } = {}) => {
      if (p.limit !== undefined && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 50)) {
        throw new Error('limit must be an integer 1-50');
      }
      const params = Object.fromEntries(
        Object.entries(p).filter(([, v]) => v !== undefined),
      );
      return executor('list_coins', params);
    },

    /**
     * One coin: market data, what it trades in, hooks, Backed Floor price
     * and reserve, loans, launch gate, and the wallet's balance and loans
     * on it. Read-only.
     */
    coinInfo: (token: string) => executor('coin_info', { token: requireTokenAddress(token) }),

    /**
     * Step 1 of the Agent Pass: returns five short tasks plus a challenge
     * id. Answer them with foundry_request_claim_agent_pass (step 2).
     * With an ERC-8004 id, starts Hookit's ERC-8004 validation path instead
     * of a plain pass. Read-only — nothing is signed here.
     */
    agentPassChallenge: (erc8004Id?: string) =>
      executor(
        'agent_pass_challenge',
        erc8004Id === undefined ? {} : { agentId: requireErc8004Id(erc8004Id) },
      ),

    /**
     * Dry-run a launch. dryRun is FORCED true on the underlying call — the
     * caller cannot switch it off, and this path never signs. Always
     * attaches the plain-words anti-snipe disclosure: every Hookit preset
     * opens with ~90% anti-snipe for ~30s, and the executor result can
     * mention "snipe" in machine-readable form without disclosing it.
     * Never rely on agent diligence for this disclosure. (Mirrors the
     * HTTP bridge in the 402 monorepo — keep the wording in sync.)
     */
    prepareLaunch: async (p: LaunchParams) => {
      validateLaunchParams(p);
      const { ...rest } = p as unknown as Record<string, unknown>;
      delete rest.dryRun; // belt and suspenders: the flag is ours, not the caller's
      // snipeTaxPct is Foundry-side disclosure metadata — hookit-mcp has no
      // such launch param, so it never goes over the wire.
      delete rest.snipeTaxPct;
      rest.payout = normalizePayoutTarget(rest.payout);
      if (rest.payout === undefined) delete rest.payout;
      const result = await executor('launch_token', { ...rest, dryRun: true });
      return {
        result,
        warnings: [
          'Opening anti-snipe tax: this launch opens with a 90% anti-snipe tax for about 30 seconds. The coin will look like a honeypot until it lifts. This is standard on Hookit launches, not a defect in the coin.',
        ],
      };
    },

    // ---- gated: writes a pending approval, never executes ----

    requestLaunch: (p: LaunchParams & { erc8004Id: string }) => {
      const erc8004Id = requireErc8004Id(p.erc8004Id);
      validateLaunchParams(p);
      const { erc8004Id: _gate, ...params } = p;
      // Normalize the payout for the wire, but KEEP snipeTaxPct on the stored
      // params: it is disclosure metadata for the launch row, stripped at
      // execution time (hookit-mcp has no such launch param).
      const stored: Record<string, unknown> = { ...params };
      stored.payout = normalizePayoutTarget(stored.payout);
      if (stored.payout === undefined) delete stored.payout;
      const moduleEntries = p.modules ? Object.entries(p.modules) : [];
      const modules = moduleEntries.length
        ? `, modules {${moduleEntries.map(([k, v]) => `${k}: ${v}`).join(', ')}}`
        : '';
      const pairs = p.pairs?.length ? `, extra pairs [${p.pairs.join(', ')}]` : '';
      const summary =
        `Launch request: agent ${erc8004Id} wants to launch "${p.name}" (${p.symbol}) ` +
        `on pair ${p.pair}${pairs} with preset "${p.preset ?? 'default'}"${modules}. ` +
        `Hook tax ${p.hookTaxPct ?? 0}%, dev buy ${p.devBuyPct ?? 0}%, ` +
        `opening snipe tax DISCLOSED at ${p.snipeTaxPct ?? 90}% (standard practice). ` +
        `Approving SIGNs and BROADCASTs a real launch transaction on Ink — ` +
        `spending the launch fee plus gas from the launch wallet — and then collects the ` +
        `${FOUNDRY_FEE_ETH} ETH Foundry fee to the 402 treasury. If the launch fails, no fee is collected. ` +
        `Nothing is signed until a human approves.`;
      return storeRequest('launch', erc8004Id, stored, summary);
    },

    requestClaimFees: (p: { erc8004Id: string }) => {
      const erc8004Id = requireErc8004Id(p.erc8004Id);
      const summary =
        `Fee-claim request: agent ${erc8004Id} wants to collect creator fees earned by the ` +
        `launch wallet. Approving will SIGN and BROADCAST a claim transaction on Ink (gas only). ` +
        `Nothing moves until a human approves.`;
      return storeRequest('claim_fees', erc8004Id, {}, summary);
    },

    requestSendEth: (p: { erc8004Id: string; to: string; amount: string }) => {
      const erc8004Id = requireErc8004Id(p.erc8004Id);
      if (!/^0x[0-9a-fA-F]{40}$/.test(p.to)) throw new Error('to must be a 0x EVM address');
      if (!p.amount) throw new Error('amount is required');
      const maxWarn = p.amount.toLowerCase() === 'max'
        ? ' WARNING: amount is "max" — this drains the entire launch wallet.'
        : '';
      const summary =
        `Send request: agent ${erc8004Id} wants to send ${p.amount} ETH to ${p.to}.${maxWarn} ` +
        `Approving will SIGN and BROADCAST a real ETH transfer on Ink. Nothing moves until a human approves.`;
      return storeRequest('send_eth', erc8004Id, { to: p.to, amount: p.amount }, summary);
    },

    /**
     * Request claiming the Hookit Agent Pass (step 2 of the pass flow — step
     * 1 is foundry_agent_pass_challenge). Signs the answers with the launch
     * wallet and claims the pass onchain. Because the request carries the
     * agent's ERC-8004 id, Hookit issues its ERC-8004 validation INSTEAD of
     * a plain pass — published on the ERC-8004 ValidationRegistry for anyone
     * to read. The launch wallet must be the identity's agentWallet for the
     * validation path; otherwise the wallet gets a plain non-transferable
     * pass. Either one unlocks buying AI-agent-only coins in their gated
     * window.
     */
    requestClaimAgentPass: (p: {
      erc8004Id: string;
      challengeId: string;
      answers: (string | number)[];
      requestHash?: string;
    }) => {
      const erc8004Id = requireErc8004Id(p.erc8004Id);
      if (!p.challengeId) throw new Error('challengeId is required (from foundry_agent_pass_challenge)');
      if (!Array.isArray(p.answers) || p.answers.length === 0) {
        throw new Error('answers must be a non-empty array, in task order');
      }
      const params: Record<string, unknown> = {
        id: p.challengeId,
        answers: p.answers,
        agentId: erc8004Id,
      };
      if (p.requestHash !== undefined) {
        if (!/^0x[0-9a-fA-F]{64}$/.test(p.requestHash)) {
          throw new Error('requestHash must be a 0x hash');
        }
        params.requestHash = p.requestHash;
      }
      const summary =
        `Agent-pass request: agent ${erc8004Id} wants to claim the Hookit Agent Pass ` +
        `(challenge ${p.challengeId}). Approving SIGNS and BROADCASTs the claim on Ink ` +
        `(a little gas). With the agent's ERC-8004 id attached, Hookit publishes its ` +
        `ERC-8004 validation to the ValidationRegistry instead of a plain pass — ` +
        `readable by anyone, forever. The pass/validation unlocks buying AI-agent-only ` +
        `coins during their gated window. Nothing is signed until a human approves.`;
      return storeRequest('claim_agent_pass', erc8004Id, params, summary);
    },

    /**
     * Request buying a hookit coin. hookit-mcp caps a single buy at 0.5 ETH
     * or $1000; anything the coin does not trade in is routed through Relay
     * first (two transactions, simulated before signing).
     */
    requestBuyToken: (p: {
      erc8004Id: string;
      token: string;
      amount: string | number;
      payWith?: string;
      slippageBps?: number;
    }) => {
      const erc8004Id = requireErc8004Id(p.erc8004Id);
      const token = requireTokenAddress(p.token);
      if (p.amount === undefined || p.amount === '') throw new Error('amount is required');
      const slippageBps = requireSlippageBps(p.slippageBps);
      const params: Record<string, unknown> = { token, amount: p.amount };
      if (p.payWith !== undefined) params.payWith = p.payWith;
      if (slippageBps !== undefined) params.slippageBps = slippageBps;
      const summary =
        `Buy request: agent ${erc8004Id} wants to spend ${p.amount} ` +
        `${p.payWith ?? "the coin's own pair"} on ${token} ` +
        `(max slippage ${slippageBps ?? 500} bps). Approving SIGNS and BROADCASTs ` +
        `the buy on Ink — hookit caps one buy at 0.5 ETH / $1000. ` +
        `Nothing moves until a human approves.`;
      return storeRequest('buy_token', erc8004Id, params, summary);
    },

    /** Request selling a hookit coin for its pair, USDG, or anything via Relay. */
    requestSellToken: (p: {
      erc8004Id: string;
      token: string;
      amount: string | number;
      receive?: string;
      slippageBps?: number;
    }) => {
      const erc8004Id = requireErc8004Id(p.erc8004Id);
      const token = requireTokenAddress(p.token);
      if (p.amount === undefined || p.amount === '') throw new Error('amount is required');
      const slippageBps = requireSlippageBps(p.slippageBps);
      const params: Record<string, unknown> = { token, amount: p.amount };
      if (p.receive !== undefined) params.receive = p.receive;
      if (slippageBps !== undefined) params.slippageBps = slippageBps;
      const summary =
        `Sell request: agent ${erc8004Id} wants to sell ${p.amount} of ${token} ` +
        `for ${p.receive ?? "the coin's own pair"} (max slippage ${slippageBps ?? 500} bps). ` +
        `Approving SIGNS and BROADCASTs the sale on Ink. ` +
        `Nothing moves until a human approves.`;
      return storeRequest('sell_token', erc8004Id, params, summary);
    },

    /**
     * Request redeeming a Backed Floor coin: burns the coins and pays their
     * floor value from the reserve — exact payout, no slippage. Worth it when
     * the market pays less than the floor.
     */
    requestRedeemFloor: (p: { erc8004Id: string; token: string; amount: string | number }) => {
      const erc8004Id = requireErc8004Id(p.erc8004Id);
      const token = requireTokenAddress(p.token);
      if (p.amount === undefined || p.amount === '') throw new Error('amount is required');
      const summary =
        `Floor-redeem request: agent ${erc8004Id} wants to burn ${p.amount} of ${token} ` +
        `for its Backed Floor value. Approving SIGNS and BROADCASTs the burn on Ink — ` +
        `the coins are gone, the floor value lands in the wallet. ` +
        `Nothing moves until a human approves.`;
      return storeRequest('redeem_floor', erc8004Id, { token, amount: p.amount }, summary);
    },

    /**
     * Request borrowing against a Backed Floor: locks the coins and pays
     * their floor value minus an upfront fee (1-7%). Repay before expiry to
     * get the coins back; without repayment they burn at expiry and the
     * wallet keeps what it borrowed — nothing more is owed.
     */
    requestBorrowFloor: (p: {
      erc8004Id: string;
      token: string;
      amount: string | number;
      days?: number;
    }) => {
      const erc8004Id = requireErc8004Id(p.erc8004Id);
      const token = requireTokenAddress(p.token);
      if (p.amount === undefined || p.amount === '') throw new Error('amount is required');
      if (p.days !== undefined && ![7, 14, 30, 60, 90].includes(p.days)) {
        throw new Error('days must be one of: 7, 14, 30, 60, 90');
      }
      const params: Record<string, unknown> = { token, amount: p.amount };
      if (p.days !== undefined) params.days = p.days;
      const summary =
        `Floor-borrow request: agent ${erc8004Id} wants to lock ${p.amount} of ${token} ` +
        `and borrow its floor value for ${p.days ?? 30} days (1-7% upfront fee). ` +
        `Approving SIGNS and BROADCASTs on Ink. Repay before expiry to reclaim the ` +
        `coins; otherwise they burn and the wallet keeps the loan. ` +
        `Nothing moves until a human approves.`;
      return storeRequest('borrow_floor', erc8004Id, params, summary);
    },

    /** Request repaying a floor loan before expiry to get the locked coins back. */
    requestRepayLoan: (p: { erc8004Id: string; loanId?: string }) => {
      const erc8004Id = requireErc8004Id(p.erc8004Id);
      if (p.loanId !== undefined && !/^[0-9]+$/.test(p.loanId)) {
        throw new Error('loanId must be a decimal loan id');
      }
      const params: Record<string, unknown> = {};
      if (p.loanId !== undefined) params.loanId = p.loanId;
      const summary =
        `Loan-repay request: agent ${erc8004Id} wants to repay ` +
        `${p.loanId ? `floor loan ${p.loanId}` : 'its open floor loan'} and reclaim the locked coins. ` +
        `Approving SIGNS and BROADCASTs the repayment on Ink. ` +
        `Nothing moves until a human approves.`;
      return storeRequest('repay_loan', erc8004Id, params, summary);
    },

    // ---- human decisions ----

    /**
     * Approve a pending request and execute it against the underlying launcher.
     * The ONLY path by which a real transaction can be signed. For launches:
     * pre-flight gates (balance + simulation) run first; then the launch
     * broadcasts; the 0.001 ETH Foundry fee is collected AFTER a successful
     * launch (launch wallet -> 402 treasury). A failed launch never touches
     * the fee, so there is nothing to refund. If fee collection fails after a
     * successful launch, the launch still stands and the unpaid fee is
     * surfaced loudly — the launch row keeps feeTx null as the marker.
     */
    approve: async (approvalId: string) => {
      const row = db.getApproval(approvalId);
      if (!row) throw new Error(`approval not found: ${approvalId}`);
      if (row.status !== 'pending') {
        throw new Error(
          `approval ${approvalId} is already ${row.status}: only pending approvals can be decided`,
        );
      }
      const params = JSON.parse(row.params_json) as Record<string, unknown>;
      delete params.dryRun; // approvals are real executions by definition
      const tool = KIND_TO_TOOL[row.kind];
      const ts = now();
      db.setApprovalStatus(approvalId, 'approved', ts);
      let feeTx: string | null = null;
      let feeWarning: string | null = null;
      try {
        // Our public schema calls the field `amount`; hookit-mcp's send_eth
        // calls it `amountEth`. Translate at execution so the real tool gets
        // what it expects (passing `amount` silently drops the value).
        // snipeTaxPct is Foundry disclosure metadata — hookit-mcp has no such
        // launch param, so it is stripped here and never goes over the wire
        // (it stays on the approval/launch rows for the audit trail).
        let execParams = params;
        if (row.kind === 'send_eth') {
          execParams = { to: params.to, amountEth: params.amount };
        } else if (row.kind === 'launch') {
          const { snipeTaxPct: _disclosure, ...launchArgs } = params;
          execParams = launchArgs;
        }
        if (row.kind === 'launch') {
          // Pre-flight: balance + simulation. Anything wrong here aborts
          // BEFORE anything moves.
          await assertLaunchPreflight(executor, execParams);
        }
        const result = await executor(tool, execParams);
        const doneTs = now();
        if (row.kind === 'launch') {
          const launchTx = extractTxHash(result);
          // Record the launch BEFORE collecting the fee: if the process dies
          // between launch and fee, the row still exists with feeTx null.
          const launchId = recordLaunch(
            row, params as unknown as LaunchParams, result, launchTx, null, doneTs,
          );
          // Fee-after-launch: a failed launch never reaches this line, so no
          // fee ever moves on a failed launch — nothing to refund.
          try {
            const feeResult = await executor('send_eth', {
              to: FOUNDRY_FEE_RECIPIENT,
              amountEth: FOUNDRY_FEE_ETH, // hookit-mcp's param name, not `amount`
            });
            feeTx = extractTxHash(feeResult);
            if (feeTx) {
              db.setLaunchFeeTx(launchId, feeTx);
              db.setApprovalFeeTx(approvalId, feeTx);
            } else {
              feeWarning =
                `Launch succeeded but the ${FOUNDRY_FEE_ETH} ETH fee transfer returned no tx hash. ` +
                `Verify onchain; collect it manually if it did not land in the 402 treasury ${FOUNDRY_FEE_RECIPIENT}.`;
            }
          } catch (e) {
            feeWarning =
              `Launch succeeded, but collecting the ${FOUNDRY_FEE_ETH} ETH Foundry fee failed: ` +
              `${(e as Error).message}. The fee is still due to the 402 treasury ${FOUNDRY_FEE_RECIPIENT} — ` +
              `collect it with foundry_request_send_eth.`;
          }
        }
        db.setApprovalStatus(approvalId, 'executed', doneTs);
        return { approval: toApprovalRecord(db.getApproval(approvalId)!), result, feeTx, feeWarning };
      } catch (e) {
        db.setApprovalStatus(approvalId, 'failed', now());
        const feeNote =
          row.kind === 'launch'
            ? ' No fee was collected: the fee is only taken after a successful launch.'
            : '';
        throw new Error(`${(e as Error).message}.${feeNote}`);
      }
    },

    reject: (approvalId: string) => {
      const row = db.getApproval(approvalId);
      if (!row) throw new Error(`approval not found: ${approvalId}`);
      if (row.status !== 'pending') {
        throw new Error(
          `approval ${approvalId} is already ${row.status}: only pending approvals can be decided`,
        );
      }
      db.setApprovalStatus(approvalId, 'rejected', now());
      return toApprovalRecord(db.getApproval(approvalId)!);
    },

    // ---- reads ----

    getApproval: (approvalId: string) => {
      const row = db.getApproval(approvalId);
      return row ? toApprovalRecord(row) : null;
    },

    listApprovals: (status?: ApprovalStatus) =>
      db.listApprovals(status).map(toApprovalRecord),

    listLaunches: (erc8004Id?: string) =>
      db.listLaunches(erc8004Id).map(toLaunchRecord),
  };
}

export type FoundryService = ReturnType<typeof createFoundryService>;
