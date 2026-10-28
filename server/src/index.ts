import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { PORT, WEB_DIST, DATA_DIR } from './config.js';
import { recoverStaleState } from './store/db.js';
import { api } from './routes.js';
import { kickQueue } from './services/orchestrator.js';
import { archStore, logStore } from './store/repo-store.js';
import { resolveAiSettings, secureSettingsFile } from './store/settings.js';
import { log } from './lib/log.js';
import { seedDemo } from './services/demo.js';

const recovered = recoverStaleState();
if (recovered.released.length) {
  // half-built worktrees from the interrupted run are useless; free the disk
  const { cleanupWorkspace } = await import('./services/workspace.js');
  await Promise.allSettled(recovered.released.map((id) => cleanupWorkspace(id)));
  console.log(`[recovery] 释放了 ${recovered.released.length} 个中断的需求状态并清理其临时工作区`);
}

// Existing installs may have a world-readable settings.json (plaintext API key).
secureSettingsFile();
// Bound the log table before serving anything.
try {
  const pruned = logStore.prune();
  if (pruned) console.log(`[logs] 已清理 ${pruned} 条历史日志`);
} catch {
  /* non-fatal */
}

// first run: offer a populated demo instead of an empty shell
if (process.env.OHPERT_SEED_DEMO !== '0') {
  try {
    const { repoStore, requirementStore } = await import('./store/repo-store.js');
    if (!repoStore.list().length && !requirementStore.list().length) await seedDemo();
  } catch (err) {
    console.error('[demo] seed skipped:', (err as Error).message);
  }
}

const app = new Hono();

/** Only loopback hosts/origins may talk to this unauthenticated local API. */
function isLoopbackHostname(name: string): boolean {
  const host = name.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function hostnameOf(value: string): string {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return '';
  }
}

app.use('*', async (c, next) => {
  // DNS rebinding: a hostile page can resolve its own domain to 127.0.0.1, but
  // the Host header then still carries that domain.
  const host = c.req.header('host');
  if (host && !isLoopbackHostname(hostnameOf(host))) {
    return c.json({ error: '仅允许通过 127.0.0.1 / localhost 访问 ohpert' }, 403);
  }
  // Cross-origin browser requests (including from another localhost port).
  const origin = c.req.header('origin');
  if (origin && !isLoopbackHostname(hostnameOf(origin))) {
    return c.json({ error: '拒绝来自非本机来源的请求' }, 403);
  }
  if (c.req.path.startsWith('/api') && c.req.header('sec-fetch-site') === 'cross-site') {
    return c.json({ error: '拒绝跨站请求' }, 403);
  }
  await next();
});

app.use('*', async (c, next) => {
  const started = Date.now();
  await next();
  if (c.req.path.startsWith('/api') && !c.req.path.startsWith('/api/events')) {
    const ms = Date.now() - started;
    if (ms > 800) console.log(`slow ${c.req.method} ${c.req.path} ${ms}ms`);
  }
});

app.route('/api', api);

// static frontend (production build) — dev uses the Vite server with a proxy
if (fs.existsSync(WEB_DIST)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), WEB_DIST) || '.' }));
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api')) return next();
    const html = fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8');
    return c.html(html);
  });
} else {
  app.get('/', (c) =>
    c.html(
      `<html><body style="font-family:system-ui;padding:40px;background:#0b0f18;color:#e2e8f0">
        <h2>ohpert 服务已启动 🚀</h2>
        <p>前端尚未构建。开发模式请访问 Vite：<a style="color:#38bdf8" href="http://127.0.0.1:5273">http://127.0.0.1:5273</a></p>
        <p>生产模式请先运行 <code>pnpm build</code>。</p>
        <p>API：<a style="color:#38bdf8" href="/api/health">/api/health</a></p>
      </body></html>`,
    ),
  );
}

const ai = resolveAiSettings();

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log('');
  console.log('  \x1b[36mohpert\x1b[0m — AI 需求管理与研发平台');
  console.log(`  ├─ API        http://127.0.0.1:${info.port}/api`);
  console.log(
    `  ├─ 前端       ${fs.existsSync(WEB_DIST) ? `http://127.0.0.1:${info.port}` : 'http://127.0.0.1:5273 (vite dev)'}`,
  );
  console.log(`  ├─ 数据目录   ${DATA_DIR}`);
  console.log(`  ├─ 模型       ${ai.model} @ ${ai.baseURL} ${ai.apiKey ? '(已配置 Key)' : '(无 Key)'}`);
  console.log(`  ├─ 工程数量   ${archStore.get() ? '已生成架构图谱' : '尚未分析架构'}`);
  console.log('');
  log('info', `服务启动于端口 ${info.port}`);
  kickQueue();
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  log('error', `未处理的异常: ${(reason as Error)?.message ?? String(reason)}`);
});
