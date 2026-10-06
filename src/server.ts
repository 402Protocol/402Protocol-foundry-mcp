/**
 * Foundry MCP server — the agent-only token launchpad on Ink, safety-first.
 *
 * This server wraps the hookit launch MCP (16 tools, zero confirmation gates)
 * with the Foundry safety layer:
 *
 *   Passthrough (always safe, never signs):
 *     foundry_list_presets, foundry_list_modules, foundry_list_pairs,
 *     foundry_wallet_status, foundry_list_coins, foundry_coin_info,
 *     foundry_agent_pass_challenge, foundry_prepare_launch (FORCES dryRun:true)
 *
 *   Gated (never execute directly — they write a pending approval):
 *     foundry_request_launch, foundry_request_claim_fees, foundry_request_send_eth,
 *     foundry_request_claim_agent_pass, foundry_request_buy_token,
 *     foundry_request_sell_token, foundry_request_redeem_floor,
 *     foundry_request_borrow_floor, foundry_request_repay_loan
 *     foundry_approve / foundry_reject — the human decision. approve() is the
 *     ONLY path that can sign and broadcast a real transaction.
 *
 *   Reads:
 *     foundry_approvals, foundry_launches (per-agent reputation trail)
 *
 * Identity gate: every request_* tool requires the agent's ERC-8004 id.
 * No ID, no launch.
 *
 * Key posture: this server NEVER embeds private keys and never accepts them
 * as tool arguments. The underlying launcher reads HOOKIT_PRIVATE_KEY from
 * the process environment (its own documented config) and refuses to run
 * without it. Signing happens inside the launcher child process, locally.
 *
 *   FOUNDRY_DB_PATH   SQLite path for approvals + launch records
 *                     (default ./data/foundry.db)
 *
 * Run: npx -y 402-foundry-mcp@latest   (published package)
 *      npm run mcp                (from source: npx -y tsx src/server.ts)
 */
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FoundryDb, type ApprovalStatus } from './db.js';
import {
  createFoundryService,
  defaultHookitExecutor,
  type LaunchParams,
} from './service.js';

export interface FoundryConfig {
  dbPath: string;
}

export function loadFoundryConfig(
  env: Record<string, string | undefined> = process.env,
): FoundryConfig {
  return { dbPath: (env.FOUNDRY_DB_PATH ?? '').trim() || 'data/foundry.db' };
}

/** JSON with bigints rendered as decimal strings. */
function textResult(value: unknown): {
  content: { type: 'text'; text: string }[];
} {
  const text = JSON.stringify(
    value,
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string, detail?: unknown) {
  return textResult({ ok: false, error: message, ...(detail !== undefined ? { detail } : {}) });
}

const erc8004IdSchema = z
  .string()
  .regex(
    /^\d+$/,
    'erc8004Id must be your ERC-8004 agent identity id as a decimal string (e.g. "4076"). No ID, no launch.',
  );

const launchInputSchema = {
  name: z.string().describe('Token name, 1-32 characters'),
  symbol: z.string().optional().describe('Token symbol, 1-12 letters or digits (or pass ticker)'),
  ticker: z.string().optional().describe('Plain-words alias for symbol'),
  pair: z.string().describe('Quote pair id from foundry_list_pairs (e.g. "eth")'),
  pairs: z
    .array(z.string())
    .optional()
    .describe(
      'Multi-pair launch: extra quote pairs beyond `pair` (USDG and stock pairs only, ids from foundry_list_pairs, e.g. ["usdg", "wnvdax"]). Omit for a single-pair launch.',
    ),
  preset: z.string().optional().describe('Preset id from foundry_list_presets'),
  modules: z
    .record(z.string(), z.union([z.boolean(), z.number()]))
    .optional()
    .describe(
      'Hook module settings from foundry_list_modules, e.g. {"autoBurn": true, "autoBurnPct": 100}. Omit to use the preset as-is.',
    ),
  hookTaxPct: z.number().min(0).max(9).optional().describe('Extra hook tax %, 0-9 (hookit range)'),
  devBuyPct: z.number().min(0).max(2.5).optional().describe('Creator first buy, % of supply, 0-2.5'),
  snipeTaxPct: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe('Opening snipe tax % to DISCLOSE on the launch (standard practice: 90). Disclosure only — recorded on the launch, not sent to hookit.'),
  payout: z
    .union([
      z.string(),
      z.object({
        kind: z.enum(['wallet', 'x', 'github', 'tiktok']),
        address: z.string().optional(),
        handle: z.string().optional(),
        accountId: z.string().optional(),
      }),
    ])
    .optional()
    .describe(
      'Fee payout target: a 0x wallet address, an @handle, or {kind, address|handle|accountId}. Default: the launch wallet.',
    ),
  description: z.string().optional(),
  image: z.string().optional(),
  twitter: z.string().optional(),
  telegram: z.string().optional(),
  website: z.string().optional(),
};

/** Map tool args onto LaunchParams. `ticker` is the plain-words alias fresh
 * agents reach for; the schema calls it `symbol`. Exported for tests. */
export function toLaunchParams(args: Record<string, unknown>): LaunchParams {
  const { erc8004Id: _gate, ...rest } = args;
  if (rest.symbol === undefined && typeof rest.ticker === 'string') {
    rest.symbol = rest.ticker;
  }
  delete rest.ticker;
  return rest as unknown as LaunchParams;
}

export function createFoundryServer(config: FoundryConfig): McpServer {
  const db = new FoundryDb(config.dbPath);
  const svc = createFoundryService({ db, executor: defaultHookitExecutor });
  const server = new McpServer(
    { name: 'foundry', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  const safe = <T>(fn: () => Promise<T> | T) => async () => {
    try {
      return textResult({ ok: true, result: await fn() });
    } catch (e) {
      return errorResult('foundry tool failed', (e as Error).message);
    }
  };

  // ---- passthrough: always safe, never signs ----

  server.registerTool(
    'foundry_list_presets',
    { description: 'List launch strategies by goal, with the exact hook modules each one turns on. Read-only.' },
    safe(() => svc.listPresets()),
  );

  server.registerTool(
    'foundry_list_modules',
    { description: 'List every hook module, its settings, and the rules a combination must follow. Read-only.' },
    safe(() => svc.listModules()),
  );

  server.registerTool(
    'foundry_list_pairs',
    { description: 'List what a coin can be priced in (ETH, USDG, kBTC, tokenized stocks...). Read-only.' },
    safe(() => svc.listPairs()),
  );

  server.registerTool(
    'foundry_wallet_status',
    { description: 'Check whether the launch wallet holds enough ETH to launch. Read-only, plain-words.' },
    safe(() => svc.walletStatus()),
  );

  server.registerTool(
    'foundry_list_coins',
    {
      description:
        'Browse hookit coins: newest, top market cap, volume, or 24h gainers. Filter for AI-agent-only, gated, launched-by-agents, Backed Floor, or Boss Raid coins, by pair, or by name. Read-only.',
      inputSchema: {
        sort: z.enum(['new', 'marketcap', 'volume', 'gainers']).optional().describe('Default new.'),
        filter: z
          .enum(['all', 'ai_agents_only', 'gated', 'launched_by_agents', 'backed_floor', 'boss_raid'])
          .optional()
          .describe('ai_agents_only and gated: coins whose launch gate is still closed. Default all.'),
        pair: z.string().optional().describe('Only coins priced in this pair: "eth", "usdg", "wNVDAx"...'),
        search: z.string().optional().describe('Part of a name or ticker.'),
        limit: z.number().int().min(1).max(50).optional().describe('Default 20.'),
      },
    },
    async (args) => {
      try {
        return textResult({ ok: true, result: await svc.listCoins(args) });
      } catch (e) {
        return errorResult('list_coins failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'foundry_coin_info',
    {
      description:
        "One coin: market data, what it trades in, hooks, Backed Floor price and reserve, loans, launch gate, and the wallet's balance and loans on it. Read-only.",
      inputSchema: {
        token: z.string().describe("The coin's 0x address on Ink"),
      },
    },
    async (args) => {
      try {
        return textResult({ ok: true, result: await svc.coinInfo(args.token) });
      } catch (e) {
        return errorResult('coin_info failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'foundry_agent_pass_challenge',
    {
      description:
        'Step 1 of the Hookit Agent Pass: returns five short tasks plus a challenge id. Answer them via foundry_request_claim_agent_pass (step 2). Pass your ERC-8004 id to start Hookit\'s ERC-8004 validation path instead of a plain pass — the launch wallet must be the identity\'s agent wallet for that path. Read-only, never signs.',
      inputSchema: {
        erc8004Id: z
          .string()
          .regex(/^\d+$/, 'erc8004Id must be your ERC-8004 agent identity id as a decimal string.')
          .optional()
          .describe("Your ERC-8004 agent identity id, for the validation path. Omit for a plain pass check."),
      },
    },
    async (args) => {
      try {
        return textResult({ ok: true, result: await svc.agentPassChallenge(args.erc8004Id) });
      } catch (e) {
        return errorResult('agent_pass_challenge failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'foundry_prepare_launch',
    {
      description:
        'DRY-RUN a token launch: validates the combination and returns the full UNSIGNED transaction plus a simulation, without signing anything. dryRun is forced on — this tool can never sign or broadcast. Use it before any foundry_request_launch.',
      inputSchema: launchInputSchema,
    },
    async (args) => {
      try {
        const { result, warnings } = await svc.prepareLaunch(toLaunchParams(args));
        return textResult({ ok: true, dryRun: true, warnings, result });
      } catch (e) {
        return errorResult('prepare_launch failed', (e as Error).message);
      }
    },
  );

  // ---- gated: writes a pending approval, never executes ----

  server.registerTool(
    'foundry_request_launch',
    {
      description:
        'Request a REAL token launch. Does NOT launch: writes a pending approval and returns its id plus a plain-words summary of what approving would do. Requires your ERC-8004 agent id — no ID, no launch. A human must call foundry_approve before anything is signed.',
      inputSchema: { ...launchInputSchema, erc8004Id: erc8004IdSchema },
    },
    async (args) => {
      try {
        const rec = svc.requestLaunch({ ...toLaunchParams(args), erc8004Id: args.erc8004Id });
        return textResult({
          ok: true,
          approvalId: rec.id,
          status: rec.status,
          summary: rec.summary,
          note: 'Pending human approval. Nothing is signed until foundry_approve is called on this id.',
        });
      } catch (e) {
        return errorResult('request_launch rejected', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'foundry_request_claim_fees',
    {
      description:
        'Request collecting creator fees the launch wallet earned. Does NOT claim: writes a pending approval. Requires your ERC-8004 agent id. A human must call foundry_approve before anything is signed.',
      inputSchema: { erc8004Id: erc8004IdSchema },
    },
    async (args) => {
      try {
        const rec = svc.requestClaimFees({ erc8004Id: args.erc8004Id });
        return textResult({
          ok: true,
          approvalId: rec.id,
          status: rec.status,
          summary: rec.summary,
          note: 'Pending human approval. Nothing moves until foundry_approve is called on this id.',
        });
      } catch (e) {
        return errorResult('request_claim_fees rejected', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'foundry_request_send_eth',
    {
      description:
        'Request sending ETH from the launch wallet. Does NOT send: writes a pending approval. Requires your ERC-8004 agent id. A human must call foundry_approve before anything is signed.',
      inputSchema: {
        erc8004Id: erc8004IdSchema,
        to: z.string().describe('Destination 0x address'),
        amount: z.string().describe('ETH amount as a decimal string, or "max" (drains the wallet)'),
      },
    },
    async (args) => {
      try {
        const rec = svc.requestSendEth({
          erc8004Id: args.erc8004Id,
          to: args.to,
          amount: args.amount,
        });
        return textResult({
          ok: true,
          approvalId: rec.id,
          status: rec.status,
          summary: rec.summary,
          note: 'Pending human approval. Nothing moves until foundry_approve is called on this id.',
        });
      } catch (e) {
        return errorResult('request_send_eth rejected', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'foundry_request_claim_agent_pass',
    {
      description:
        'Request claiming the Hookit Agent Pass (step 2 — get the challenge from foundry_agent_pass_challenge first). Does NOT claim: writes a pending approval. Requires your ERC-8004 agent id, which Hookit turns into an ERC-8004 validation published on the ValidationRegistry instead of a plain pass. A human must call foundry_approve before anything is signed.',
      inputSchema: {
        erc8004Id: erc8004IdSchema,
        challengeId: z.string().describe('The challenge id from foundry_agent_pass_challenge'),
        answers: z
          .array(z.union([z.string(), z.number()]))
          .describe('Your answers to the five tasks, in the same order: one short answer per task'),
        requestHash: z
          .string()
          .regex(/^0x[0-9a-fA-F]{64}$/, 'requestHash must be a 0x hash')
          .optional()
          .describe('Only with a pre-sent validationRequest: its hash, so Hookit publishes to it.'),
      },
    },
    async (args) => {
      try {
        const rec = svc.requestClaimAgentPass({
          erc8004Id: args.erc8004Id,
          challengeId: args.challengeId,
          answers: args.answers,
          requestHash: args.requestHash,
        });
        return textResult({
          ok: true,
          approvalId: rec.id,
          status: rec.status,
          summary: rec.summary,
          note: 'Pending human approval. Nothing is signed until foundry_approve is called on this id.',
        });
      } catch (e) {
        return errorResult('request_claim_agent_pass rejected', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'foundry_request_buy_token',
    {
      description:
        'Request buying a hookit coin. Does NOT buy: writes a pending approval. Requires your ERC-8004 agent id. One buy is capped at 0.5 ETH / $1000 by hookit. A human must call foundry_approve before anything is signed.',
      inputSchema: {
        erc8004Id: erc8004IdSchema,
        token: z.string().describe("The coin's 0x address on Ink"),
        amount: z
          .union([z.string(), z.number()])
          .describe('What to spend, in payWith units: "0.01" (ETH), "25" (USDG), or "50%" of the balance'),
        payWith: z
          .string()
          .optional()
          .describe('"eth", "usdg", a pair ticker from foundry_list_pairs such as "wNVDAx" or "kBTC", or a token address. Default: the coin\'s own pair.'),
        slippageBps: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe('Max slippage in basis points, 1-5000. Default 500 (5%).'),
      },
    },
    async (args) => {
      try {
        const rec = svc.requestBuyToken({
          erc8004Id: args.erc8004Id,
          token: args.token,
          amount: args.amount,
          payWith: args.payWith,
          slippageBps: args.slippageBps,
        });
        return textResult({
          ok: true,
          approvalId: rec.id,
          status: rec.status,
          summary: rec.summary,
          note: 'Pending human approval. Nothing moves until foundry_approve is called on this id.',
        });
      } catch (e) {
        return errorResult('request_buy_token rejected', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'foundry_request_sell_token',
    {
      description:
        'Request selling a hookit coin. Does NOT sell: writes a pending approval. Requires your ERC-8004 agent id. A human must call foundry_approve before anything is signed.',
      inputSchema: {
        erc8004Id: erc8004IdSchema,
        token: z.string().describe("The coin's 0x address on Ink"),
        amount: z
          .union([z.string(), z.number()])
          .describe('Coins to sell: "1000000", "max" or "50%". "max" keeps 1 wei of the coin.'),
        receive: z
          .string()
          .optional()
          .describe('"eth", "usdg", a pair ticker such as "wNVDAx" or "kBTC", or a token address. Default: the coin\'s own pair.'),
        slippageBps: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe('Max slippage in basis points, 1-5000. Default 500 (5%).'),
      },
    },
    async (args) => {
      try {
        const rec = svc.requestSellToken({
          erc8004Id: args.erc8004Id,
          token: args.token,
          amount: args.amount,
          receive: args.receive,
          slippageBps: args.slippageBps,
        });
        return textResult({
          ok: true,
          approvalId: rec.id,
          status: rec.status,
          summary: rec.summary,
          note: 'Pending human approval. Nothing moves until foundry_approve is called on this id.',
        });
      } catch (e) {
        return errorResult('request_sell_token rejected', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'foundry_request_redeem_floor',
    {
      description:
        'Request redeeming a Backed Floor coin: burns the coins for their exact floor value from the reserve, no slippage. Does NOT redeem: writes a pending approval. Requires your ERC-8004 agent id. A human must call foundry_approve before anything is signed.',
      inputSchema: {
        erc8004Id: erc8004IdSchema,
        token: z.string().describe("The coin's 0x address on Ink"),
        amount: z
          .union([z.string(), z.number()])
          .describe('Coins to redeem: "1000000", "max" or "50%". "max" keeps 1 wei of the coin.'),
      },
    },
    async (args) => {
      try {
        const rec = svc.requestRedeemFloor({
          erc8004Id: args.erc8004Id,
          token: args.token,
          amount: args.amount,
        });
        return textResult({
          ok: true,
          approvalId: rec.id,
          status: rec.status,
          summary: rec.summary,
          note: 'Pending human approval. Nothing moves until foundry_approve is called on this id.',
        });
      } catch (e) {
        return errorResult('request_redeem_floor rejected', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'foundry_request_borrow_floor',
    {
      description:
        'Request borrowing against a Backed Floor: locks the coins and pays their floor value minus an upfront fee (1-7%). Repay before expiry to get the coins back. Does NOT borrow: writes a pending approval. Requires your ERC-8004 agent id. A human must call foundry_approve before anything is signed.',
      inputSchema: {
        erc8004Id: erc8004IdSchema,
        token: z.string().describe("The coin's 0x address on Ink"),
        amount: z
          .union([z.string(), z.number()])
          .describe('Coins to lock: "1000000", "50%", or "max" (the most the wallet and the loan cap allow).'),
        days: z
          .union([z.literal(7), z.literal(14), z.literal(30), z.literal(60), z.literal(90)])
          .optional()
          .describe('Loan length in days. Default 30.'),
      },
    },
    async (args) => {
      try {
        const rec = svc.requestBorrowFloor({
          erc8004Id: args.erc8004Id,
          token: args.token,
          amount: args.amount,
          days: args.days,
        });
        return textResult({
          ok: true,
          approvalId: rec.id,
          status: rec.status,
          summary: rec.summary,
          note: 'Pending human approval. Nothing moves until foundry_approve is called on this id.',
        });
      } catch (e) {
        return errorResult('request_borrow_floor rejected', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'foundry_request_repay_loan',
    {
      description:
        'Request repaying a floor loan before expiry to get the locked coins back. Does NOT repay: writes a pending approval. Requires your ERC-8004 agent id. A human must call foundry_approve before anything is signed.',
      inputSchema: {
        erc8004Id: erc8004IdSchema,
        loanId: z
          .string()
          .regex(/^[0-9]+$/, 'loanId must be a decimal loan id')
          .optional()
          .describe('The loan id from foundry_request_borrow_floor or foundry_wallet_status. Default: the only open loan.'),
      },
    },
    async (args) => {
      try {
        const rec = svc.requestRepayLoan({ erc8004Id: args.erc8004Id, loanId: args.loanId });
        return textResult({
          ok: true,
          approvalId: rec.id,
          status: rec.status,
          summary: rec.summary,
          note: 'Pending human approval. Nothing moves until foundry_approve is called on this id.',
        });
      } catch (e) {
        return errorResult('request_repay_loan rejected', (e as Error).message);
      }
    },
  );

  // ---- human decisions: the only path to a real transaction ----

  server.registerTool(
    'foundry_approve',
    {
      description:
        'HUMAN ONLY: approve a pending request and execute it. This is the single path by which a real transaction can be signed and broadcast — prepare, sign, broadcast happen here and only here.',
      inputSchema: { approvalId: z.string().describe('The pending approval id from a foundry_request_* call') },
    },
    async (args) => {
      try {
        const { approval, result, feeTx, feeWarning } = await svc.approve(args.approvalId);
        return textResult({
          ok: true, approvalId: approval.id, status: approval.status,
          feeTx, feeWarning, result,
        });
      } catch (e) {
        return errorResult('approve failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'foundry_reject',
    {
      description: 'HUMAN ONLY: reject a pending request. Nothing is executed; the row is kept as an audit trail.',
      inputSchema: { approvalId: z.string().describe('The pending approval id from a foundry_request_* call') },
    },
    async (args) => {
      try {
        const rec = svc.reject(args.approvalId);
        return textResult({ ok: true, approvalId: rec.id, status: rec.status });
      } catch (e) {
        return errorResult('reject failed', (e as Error).message);
      }
    },
  );

  // ---- reads: approvals audit trail + per-agent reputation ----

  server.registerTool(
    'foundry_approvals',
    {
      description: 'List approval requests (the audit trail). Filter by status, newest first.',
      inputSchema: {
        status: z
          .enum(['pending', 'approved', 'rejected', 'executed', 'failed'])
          .optional()
          .describe('Only this status'),
      },
    },
    async (args) => {
      try {
        const recs = svc.listApprovals(args.status as ApprovalStatus | undefined);
        return textResult({ ok: true, approvals: recs });
      } catch (e) {
        return errorResult('approvals read failed', (e as Error).message);
      }
    },
  );

  server.registerTool(
    'foundry_launches',
    {
      description:
        'List executed launches — the per-agent reputation trail. Filter by ERC-8004 agent id to see one agent\'s track record.',
      inputSchema: {
        erc8004Id: z.string().optional().describe('Only launches by this ERC-8004 agent id'),
      },
    },
    async (args) => {
      try {
        const recs = svc.listLaunches(args.erc8004Id);
        return textResult({ ok: true, launches: recs });
      } catch (e) {
        return errorResult('launches read failed', (e as Error).message);
      }
    },
  );

  return server;
}

// ---- stdio entrypoint ----

async function main(): Promise<void> {
  const config = loadFoundryConfig();
  const server = createFoundryServer(config);
  const transport = new StdioServerTransport();
  // Never log to stdout: it corrupts the MCP stdio protocol. stderr only.
  console.error(`[foundry] serving over stdio (db=${config.dbPath})`);
  await server.connect(transport);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[foundry] fatal: ${(e as Error).message}`);
    process.exit(1);
  });
}
