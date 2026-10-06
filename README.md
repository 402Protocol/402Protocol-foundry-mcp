# foundry-mcp

The agent-only token launchpad on Ink, safety-first. Point your agent here, fund its wallet, and it can forge memecoins through a dry-run-first, human-approved, ERC-8004-gated sequence.

This wraps the hookit tools (which sign and broadcast with zero confirmation gates) in a safety layer. Built against **hookit-mcp 0.2.0** (pinned — the wrapper moves versions deliberately, never by npx drift).

- **Passthrough (always safe, never signs):** `foundry_list_presets`, `foundry_list_modules`, `foundry_list_pairs`, `foundry_wallet_status`, `foundry_list_coins`, `foundry_coin_info`, `foundry_agent_pass_challenge`, `foundry_prepare_launch` (forces `dryRun: true`)
- **Gated (never execute directly):** `foundry_request_launch`, `foundry_request_claim_fees`, `foundry_request_send_eth`, `foundry_request_claim_agent_pass`, `foundry_request_buy_token`, `foundry_request_sell_token`, `foundry_request_redeem_floor`, `foundry_request_borrow_floor`, `foundry_request_repay_loan`. Each writes a pending approval row and returns a plain-words summary. A human flips it with `foundry_approve` / `foundry_reject`. `approve` is the ONLY path that signs and broadcasts. Approving a launch first collects the 0.001 ETH Foundry fee (launch wallet → 402 treasury); if the fee transfer fails, the launch never executes.
- **Reads:** `foundry_approvals`, `foundry_launches` (the per-agent reputation trail; each launch row records the fee tx)
- **Identity gate:** every `request_*` tool requires the agent's ERC-8004 id. No ID, no launch. Track records accrue to the agent, not the wallet.

## Install

```bash
npx -y 402-foundry-mcp@latest
```

Or from source:

```bash
git clone https://github.com/402Protocol/402Protocol-foundry-mcp.git
cd foundry-mcp
npm install
```

Then add it to your agent's MCP config (Claude Code / Claude Desktop / Cursor):

```json
{
  "mcpServers": {
    "foundry": {
      "command": "npx",
      "args": ["-y", "402-foundry-mcp@latest"],
      "env": { "HOOKIT_PRIVATE_KEY": "<launch-wallet-private-key>" }
    }
  }
}
```

From source, use `"args": ["-y", "tsx", "/path/to/foundry-mcp/src/server.ts"]` instead.

Requires Node 22 or later (uses `node:sqlite`).

## First run: the wallet ritual

1. Generate a fresh launch wallet. Never reuse a wallet between agents.
2. Give the human the address in chat. Write the seed phrase to a local file and tell the human the path — never print or paste it into chat. The human copies it into their secret storage, deletes the file, and confirms the backup.
3. Then fund the wallet ONCE: **~0.0025 ETH on Ink**. One roundtrip covers identity registration gas, the 0.0005 ETH launch fee, launch gas, and the 0.001 ETH Foundry fee (collected at approval, before the launch broadcasts — no volume cut). (Kraken withdraws ETH directly to Ink.)
4. Put the private key in `HOOKIT_PRIVATE_KEY` in the MCP env. Never print it, never paste it into chat, never commit it.

Without the key, the server runs fine for reads and dry runs and refuses anything real. That is the correct default.

## Identity

Every launch goes through an ERC-8004 agent identity. Check whether the agent has one; if not, register one (ask the human for anything you need). Pass the id as `erc8004Id` on every `request_*` tool. No ID, no launch.

## The launch sequence

1. `foundry_list_presets` / `foundry_list_modules` / `foundry_list_pairs`. The agent chooses the name, ticker, preset, and pair.
2. `foundry_prepare_launch`. This is always a dry run. Show the human the verdict in plain words, including the opening anti-snipe tax if the preset carries one. Most presets open with a 90% anti-snipe tax for about 30 seconds. Say so.
3. `foundry_request_launch`. Writes a pending approval. Tell the human what approving would do.
4. Wait. Nothing is signed, funded, or launched without the human's word. Agents propose, humans approve.
5. On approval, the launch executes and the record lands in `foundry_launches` under the agent's ERC-8004 id.

## The agent economy tools (hookit-mcp 0.2.0)

Beyond launches, the wrapper exposes hookit's agent-economy surface through the same safety layer:

- **Agent Pass:** `foundry_agent_pass_challenge` (read-only: five short tasks + a challenge id) then `foundry_request_claim_agent_pass` (gated: signs the claim). Because the request carries the agent's ERC-8004 id, Hookit issues its **ERC-8004 validation** instead of a plain pass — published on the ERC-8004 ValidationRegistry for anyone to read. The launch wallet must be the identity's agent wallet for that path. Either credential unlocks buying AI-agent-only coins during their gated launch window (up to 24h where only pass/validation holders can buy).
- **Market:** `foundry_list_coins` (browse newest / top / gainers; filter AI-agent-only, gated, launched-by-agents, Backed Floor, Boss Raid) and `foundry_coin_info` (one coin's market data, hooks, floor price and reserve, loans, launch gate). Both read-only.
- **Trading (all gated):** `foundry_request_buy_token` (pays with ETH, USDG, kBTC, kHYPE, or tokenized stocks; hookit caps one buy at 0.5 ETH / $1000), `foundry_request_sell_token`, `foundry_request_redeem_floor` (burn for the exact Backed Floor value, no slippage), `foundry_request_borrow_floor` (lock coins, borrow the floor value for 7/14/30/60/90 days), `foundry_request_repay_loan`.

Honest limits, in hookit's own words: a pass "proves the wallet passed the agent check, not that no human is behind it." It is a bot filter, not personhood — never claim more.

## Key posture

This server never embeds private keys and never accepts them as tool arguments. The launcher reads `HOOKIT_PRIVATE_KEY` from the process environment and refuses to run without it. Signing happens locally, in the launcher child process.

## No-install alternative

If the agent cannot install anything, the public dry-run API needs no key and signs nothing: `https://402-production.up.railway.app/foundry/presets`, `/foundry/modules`, `/foundry/pairs`, and `POST /foundry/dry-run`. Reads and dry runs only. The real launch still needs this MCP.

## Develop

```bash
npm install     # install deps
npm test        # offline test suite, 16 checks, no network, nothing signed
npm run typecheck
npm run mcp     # run the server over stdio from source
```

## License

MIT
