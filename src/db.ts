/**
 * FoundryDb — SQLite state for the Foundry safety wrapper (node:sqlite, DatabaseSync).
 *
 * Tables:
 *   approvals — every gated action request (launch / claim_fees / send_eth /
 *               claim_agent_pass / buy_token / sell_token / redeem_floor /
 *               borrow_floor / repay_loan / evolve_decide / evolve_plug).
 *               Rows start pending; a human flips them to approved/rejected;
 *               execution flips them to executed/failed. The approvals table
 *               IS the audit trail: nothing real happens without a row.
 *   launches  — reputation: every approved launch, bound to the launching
 *               agent's ERC-8004 identity. Track records accrue to the agent,
 *               not the wallet.
 *
 * Synchronous API, single process, CREATE TABLE IF NOT EXISTS.
 *
 * No keys, no seeds, no credentials — ever. This database holds request
 * metadata and public launch records only.
 */
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
export type ApprovalKind =
  | 'launch'
  | 'claim_fees'
  | 'send_eth'
  | 'claim_agent_pass'
  | 'buy_token'
  | 'sell_token'
  | 'redeem_floor'
  | 'borrow_floor'
  | 'repay_loan'
  | 'evolve_decide'
  | 'evolve_plug';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  erc8004_id TEXT NOT NULL,
  params_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  fee_tx TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_erc8004 ON approvals(erc8004_id);
CREATE TABLE IF NOT EXISTS launches (
  id TEXT PRIMARY KEY,
  erc8004_id TEXT NOT NULL,
  token_name TEXT NOT NULL,
  token_symbol TEXT NOT NULL,
  token_address TEXT,
  preset TEXT,
  modules_json TEXT,
  pair TEXT NOT NULL,
  snipe_tax_pct REAL,
  hook_tax_pct REAL,
  dev_buy_pct REAL,
  evolve_json TEXT,
  launch_tx TEXT,
  fee_tx TEXT,
  launched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launches_erc8004 ON launches(erc8004_id);
`;

export interface ApprovalRow {
  id: string;
  kind: ApprovalKind;
  erc8004_id: string;
  params_json: string;
  summary: string;
  status: ApprovalStatus;
  created_at: number;
  decided_at: number | null;
  /** 0.001 ETH platform fee tx (launch approvals only, once collected). */
  fee_tx: string | null;
}

export interface LaunchRow {
  id: string;
  erc8004_id: string;
  token_name: string;
  token_symbol: string;
  /** Launched token contract address (links to https://www.hookit.fun/token/<address>). */
  token_address: string | null;
  preset: string | null;
  modules_json: string | null;
  pair: string;
  snipe_tax_pct: number | null;
  hook_tax_pct: number | null;
  dev_buy_pct: number | null;
  /** Evolve launch config as passed to hookit-mcp, e.g. {"feePct":1,"maxFeePct":9}. */
  evolve_json: string | null;
  launch_tx: string | null;
  fee_tx: string | null;
  launched_at: number;
}

export class FoundryDb {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    // Migration: fee_tx on approvals records the 0.001 ETH platform fee tx
    // for launch approvals. CREATE TABLE IF NOT EXISTS won't add it to
    // pre-existing DBs, and a fee that succeeded before a failed launch
    // must stay traceable on the approval row itself.
    const apprCols = this.db
      .prepare(`PRAGMA table_info(approvals)`)
      .all() as { name: string }[];
    if (!apprCols.some((c) => c.name === 'fee_tx')) {
      this.db.exec(`ALTER TABLE approvals ADD COLUMN fee_tx TEXT`);
    }
    // Migration: fee_tx records the 0.001 ETH platform fee tx per launch.
    // CREATE TABLE IF NOT EXISTS won't add it to pre-existing DBs.
    const cols = this.db
      .prepare(`PRAGMA table_info(launches)`)
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === 'fee_tx')) {
      this.db.exec(`ALTER TABLE launches ADD COLUMN fee_tx TEXT`);
    }
    // Migration: token_address lets the agent link each launch to its page
    // on hookit.fun (https://www.hookit.fun/token/<address>).
    if (!cols.some((c) => c.name === 'token_address')) {
      this.db.exec(`ALTER TABLE launches ADD COLUMN token_address TEXT`);
    }
    // Migration (0.2.2): evolve_json records the Evolve launch config
    // ({feePct, maxFeePct, potPct}) for Evolve-decider coins.
    if (!cols.some((c) => c.name === 'evolve_json')) {
      this.db.exec(`ALTER TABLE launches ADD COLUMN evolve_json TEXT`);
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- approvals ----

  insertApproval(a: {
    id: string;
    kind: ApprovalKind;
    erc8004Id: string;
    paramsJson: string;
    summary: string;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO approvals
           (id, kind, erc8004_id, params_json, summary, status, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      )
      .run(a.id, a.kind, a.erc8004Id, a.paramsJson, a.summary, a.createdAt);
  }

  getApproval(id: string): ApprovalRow | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToApproval(row) : null;
  }

  /** Flip status and stamp decided_at. Throws if the id is unknown. */
  setApprovalStatus(id: string, status: ApprovalStatus, decidedAt: number): void {
    const info = this.db
      .prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?')
      .run(status, decidedAt, id);
    if (info.changes === 0) throw new Error(`approval not found: ${id}`);
  }

  /** Record the platform fee tx on a launch approval. Throws if the id is unknown. */
  setApprovalFeeTx(id: string, feeTx: string): void {
    const info = this.db
      .prepare('UPDATE approvals SET fee_tx = ? WHERE id = ?')
      .run(feeTx, id);
    if (info.changes === 0) throw new Error(`approval not found: ${id}`);
  }

  listApprovals(status?: ApprovalStatus): ApprovalRow[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC, rowid DESC')
          .all(status) as Record<string, unknown>[])
      : (this.db
          .prepare('SELECT * FROM approvals ORDER BY created_at DESC, rowid DESC')
          .all() as Record<string, unknown>[]);
    return rows.map(rowToApproval);
  }

  // ---- launches (reputation) ----

  insertLaunch(l: {
    id: string;
    erc8004Id: string;
    tokenName: string;
    tokenSymbol: string;
    tokenAddress: string | null;
    preset: string | null;
    modulesJson: string | null;
    pair: string;
    snipeTaxPct: number | null;
    hookTaxPct: number | null;
    devBuyPct: number | null;
    evolveJson: string | null;
    launchTx: string | null;
    feeTx: string | null;
    launchedAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO launches
           (id, erc8004_id, token_name, token_symbol, token_address, preset, modules_json, pair,
            snipe_tax_pct, hook_tax_pct, dev_buy_pct, evolve_json, launch_tx, fee_tx, launched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        l.id, l.erc8004Id, l.tokenName, l.tokenSymbol, l.tokenAddress, l.preset, l.modulesJson,
        l.pair, l.snipeTaxPct, l.hookTaxPct, l.devBuyPct, l.evolveJson, l.launchTx, l.feeTx, l.launchedAt,
      );
  }

  /** Record the platform fee tx on a launch row (collected after the launch). */
  setLaunchFeeTx(id: string, feeTx: string): void {
    const info = this.db
      .prepare('UPDATE launches SET fee_tx = ? WHERE id = ?')
      .run(feeTx, id);
    if (info.changes === 0) throw new Error(`launch not found: ${id}`);
  }

  listLaunches(erc8004Id?: string): LaunchRow[] {
    const rows = erc8004Id
      ? (this.db
          .prepare('SELECT * FROM launches WHERE erc8004_id = ? ORDER BY launched_at DESC, rowid DESC')
          .all(erc8004Id) as Record<string, unknown>[])
      : (this.db
          .prepare('SELECT * FROM launches ORDER BY launched_at DESC, rowid DESC')
          .all() as Record<string, unknown>[]);
    return rows.map(rowToLaunch);
  }
}

function rowToApproval(row: Record<string, unknown>): ApprovalRow {
  return {
    id: row.id as string,
    kind: row.kind as ApprovalKind,
    erc8004_id: row.erc8004_id as string,
    params_json: row.params_json as string,
    summary: row.summary as string,
    status: row.status as ApprovalStatus,
    created_at: row.created_at as number,
    decided_at: row.decided_at as number | null,
    fee_tx: (row.fee_tx as string | null) ?? null,
  };
}

function rowToLaunch(row: Record<string, unknown>): LaunchRow {
  return {
    id: row.id as string,
    erc8004_id: row.erc8004_id as string,
    token_name: row.token_name as string,
    token_symbol: row.token_symbol as string,
    token_address: (row.token_address as string | null) ?? null,
    preset: row.preset as string | null,
    modules_json: row.modules_json as string | null,
    pair: row.pair as string,
    snipe_tax_pct: row.snipe_tax_pct as number | null,
    hook_tax_pct: row.hook_tax_pct as number | null,
    dev_buy_pct: row.dev_buy_pct as number | null,
    evolve_json: (row.evolve_json as string | null) ?? null,
    launch_tx: row.launch_tx as string | null,
    fee_tx: row.fee_tx as string | null,
    launched_at: row.launched_at as number,
  };
}
