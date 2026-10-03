#!/usr/bin/env node
// foundry-mcp launcher: runs the compiled server over MCP stdio.
// `npm run build` (runs automatically on prepublish) must have produced dist/.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(root, 'dist', 'server.js')], {
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
