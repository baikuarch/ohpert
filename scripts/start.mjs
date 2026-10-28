#!/usr/bin/env node
// Production start: build the web app if missing, then run the compiled API (serves the SPA too).
import { existsSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

if (!existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
  console.log('› 构建前端…');
  run('pnpm', ['--filter', '@ohpert/web', 'build']);
}
if (!existsSync(path.join(root, 'server', 'dist', 'index.js'))) {
  console.log('› 编译后端…');
  run('pnpm', ['--filter', '@ohpert/server', 'build']);
}

const port = process.env.PORT || '5274';
console.log(`\n  🚀 ohpert  http://127.0.0.1:${port}\n`);
const child = spawn(process.execPath, [path.join(root, 'server', 'dist', 'index.js')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(port) },
});
child.on('exit', (code) => process.exit(code ?? 0));
