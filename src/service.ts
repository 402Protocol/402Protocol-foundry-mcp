/**
 * Foundry service — the safety wrapper around the hookit launch MCP.
 *
 * The underlying launcher signs and broadcasts with zero confirmation gates,
 * so this service never exposes its dangerous tools directly. Instead:
 *
 *   PASSTHROUGH (always safe): list_presets, list_modules, list_pairs,
 *     wallet_status, and prepare_launch — which FORCES dryRun:true on the
 *     underlying launch_token call. These never sign anything.
 *
 *   GATED (never execute directly): request_launch, request_claim_fees,
 *     request_send_eth. Each writes a pending row to the approvals table and
 *     returns a plain-words summary of what approving would do. A human
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
 * Default executor: speaks MCP stdio to a `npx -y hookit-mcp` child process.
 * Refuses to run when HOOKIT_PRIVATE_KEY is absent — without a key the child
 * cannot sign, and we fail closed instead of half-working.
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
    args: ['-y', 'hookit-mcp'],
    env: process.env as Record<string, string>,
  });
  const client = new Client(
    { name: 'foundry-executor', version: '0.1.0' },
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
};

export interface LaunchParams {
  name: string;
  symbol: string;
  pair: string;
  preset?: string;
  modules?: string[];
  hookTaxPct?: number;
  devBuyPct?: number;
  snipeTaxPct?: number;
  payout?: string;
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
}

export interface LaunchRecord {
  id: string;
  erc8004Id: string;
  tokenName: string;
  tokenSymbol: string;
  preset: string | null;
  modules: string[] | null;
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

function validateLaunchParams(p: LaunchParams): void {
  if (!p.name || p.name.length > 32) throw new Error('name must be 1-32 characters');
  if (!/^[A-Za-z0-9]{1,12}$/.test(p.symbol)) {
    throw new Error('symbol must be 1-12 letters or digits');
  }
  if (!p.pair) throw new Error('pair is required');
  if (p.devBuyPct !== undefined && (p.devBuyPct < 0 || p.devBuyPct > 2.5)) {
    throw new Error('devBuyPct must be between 0 and 2.5');
  }
  if (p.hookTaxPct !== undefined && (p.hookTaxPct < 0 || p.hookTaxPct > 100)) {
    throw new Error('hookTaxPct must be between 0 and 100');
  }
  if (p.snipeTaxPct !== undefined && (p.snipeTaxPct < 0 || p.snipeTaxPct > 100)) {
    throw new Error('snipeTaxPct must be between 0 and 100');
  }
}

/** Best-effort tx-hash extraction from an executor result (shape is launcher-defined). */
function extractTxHash(result: unknown, depth = 0): string | null {
  if (depth > 3 || result === null || typeof result !== 'object') return null;
  if (Array.isArray(result)) {
    for (const v of result) {
      const hit = extractTxHash(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (/^(txhash|transactionhash|hash)$/i.test(k) && typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)) {
      return v;
    }
    const hit = extractTxHash(v, depth + 1);
    if (hit) return hit;
  }
  return null;
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
    };
  }

  function toLaunchRecord(row: LaunchRow): LaunchRecord {
    return {
      id: row.id,
      erc8004Id: row.erc8004_id,
      tokenName: row.token_name,
      tokenSymbol: row.token_symbol,
      preset: row.preset,
      modules: row.modules_json ? (JSON.parse(row.modules_json) as string[]) : null,
      pair: row.pair,
      snipeTaxPct: row.snipe_tax_pct,
      hookTaxPct: row.hook_tax_pct,
      devBuyPct: row.dev_buy_pct,
      launchTx: row.launch_tx,
      feeTx: row.fee_tx,
      launchedAt: row.launched_at,
    };
  }

  /** Record a reputation entry after an approved launch executes. */
  function recordLaunch(approval: ApprovalRow, params: LaunchParams, result: unknown, feeTx: string | null, ts: number): void {
    db.insertLaunch({
      id: newId('lnch'),
      erc8004Id: approval.erc8004_id,
      tokenName: params.name,
      tokenSymbol: params.symbol,
      preset: params.preset ?? null,
      modulesJson: params.modules ? JSON.stringify(params.modules) : null,
      pair: params.pair,
      snipeTaxPct: params.snipeTaxPct ?? null,
      hookTaxPct: params.hookTaxPct ?? null,
      devBuyPct: params.devBuyPct ?? null,
      launchTx: extractTxHash(result),
      feeTx,
      launchedAt: ts,
    });
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
      const modules = p.modules?.length ? `, modules [${p.modules.join(', ')}]` : '';
      const summary =
        `Launch request: agent ${erc8004Id} wants to launch "${p.name}" (${p.symbol}) ` +
        `on pair ${p.pair} with preset "${p.preset ?? 'default'}"${modules}. ` +
        `Hook tax ${p.hookTaxPct ?? 0}%, dev buy ${p.devBuyPct ?? 0}%, ` +
        `opening snipe tax DISCLOSED at ${p.snipeTaxPct ?? 90}% (standard practice). ` +
        `Approving first collects the ${FOUNDRY_FEE_ETH} ETH Foundry fee from the launch wallet ` +
        `to the 402 treasury, then prepares, SIGNs, and BROADCASTs a real launch transaction on Ink — ` +
        `spending the launch fee plus gas from the launch wallet. Nothing is signed until a human approves.`;
      return storeRequest('launch', erc8004Id, params as unknown as Record<string, unknown>, summary);
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

    // ---- human decisions ----

    /**
     * Approve a pending request and execute it against the underlying launcher.
     * The ONLY path by which a real transaction can be signed. For launches,
     * the 0.001 ETH Foundry fee is collected first (launch wallet -> 402
     * treasury); if the fee transfer fails the launch never executes.
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
      try {
        let feeTx: string | null = null;
        if (row.kind === 'launch') {
          const feeResult = await executor('send_eth', {
            to: FOUNDRY_FEE_RECIPIENT,
            amount: FOUNDRY_FEE_ETH,
          });
          feeTx = extractTxHash(feeResult);
        }
        const result = await executor(tool, params);
        const doneTs = now();
        db.setApprovalStatus(approvalId, 'executed', doneTs);
        if (row.kind === 'launch') {
          recordLaunch(row, params as unknown as LaunchParams, result, feeTx, doneTs);
        }
        return { approval: toApprovalRecord(db.getApproval(approvalId)!), result, feeTx };
      } catch (e) {
        db.setApprovalStatus(approvalId, 'failed', now());
        throw e;
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
