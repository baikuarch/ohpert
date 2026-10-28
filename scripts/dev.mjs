#!/usr/bin/env node
// Starts the API server (tsx watch) and the Vite dev server together with a single command.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const procs = [];
function start(name, cmd, args, cwd, color) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m`;
  const pipe = (stream, out) =>
    stream.on('data', (d) => {
      for (const line of d.toString().split('\n')) if (line.trim()) out.write(`${prefix} ${line}\n`);
    });
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    console.log(`${prefix} exited (${code ?? signal})`);
    if (code && !shuttingDown) shutdown(code);
  });
  procs.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    try {
      p.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('\n  🚀 ohpert dev\n  ├─ API  http://127.0.0.1:5274/api\n  └─ Web  http://127.0.0.1:5273\n');
start('server', 'pnpm', ['--filter', '@ohpert/server', 'dev'], root, '35');
setTimeout(() => start('web', 'pnpm', ['--filter', '@ohpert/web', 'dev'], root, '36'), 800);
