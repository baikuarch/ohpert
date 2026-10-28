// Headless UI smoke test + screenshots. Usage: node scripts/ui-check.mjs [url]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

// `pnpm ui-check -- <url>` forwards a literal `--` as argv[2]; ignore it so the
// URL argument works in both `pnpm ui-check <url>` and `pnpm ui-check -- <url>`.
const args = process.argv.slice(2).filter((a) => a !== '--');
const BASE = args[0] || 'http://127.0.0.1:5273';
const OUT = path.resolve('.screenshots');
fs.mkdirSync(OUT, { recursive: true });

// playwright-core does not download browsers. Use an explicit override, a system
// Chrome/Chromium, or a browser already installed by Playwright.
const candidates = [
  process.env.OHPERT_CHROME_PATH,
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] &&
    path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
].filter(Boolean);

let executablePath = candidates.find((p) => fs.existsSync(p));
if (!executablePath) {
  try {
    const bundled = chromium.executablePath();
    if (bundled && fs.existsSync(bundled)) executablePath = bundled;
  } catch {
    /* no Playwright-managed browser */
  }
}
if (!executablePath) {
  console.error(
    '未找到 Chrome/Chromium。请安装 Chrome，或运行 `pnpm exec playwright install chromium`，' +
      '也可以通过 OHPERT_CHROME_PATH 指定浏览器路径。',
  );
  process.exit(2);
}

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 980 }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

const shot = async (name) => {
  await page.waitForTimeout(600);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('screenshot:', file);
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name} ${detail}`);
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// 1. workspace
check('工作台加载', (await page.locator('text=工程与架构').count()) > 0);
const repoCards = await page.locator('text=/AI 分析架构|重新分析架构/').count();
check('存在 AI 分析架构入口', repoCards > 0);
// repo cards are identified by their role badge, not by a hard-coded repo name
const roleBadgeCount = await page.locator('text=/^(前端|后端|全栈|库\/SDK|移动端|基础设施|未识别)$/').count();
check('工程卡片渲染', roleBadgeCount > 0, `识别到 ${roleBadgeCount} 个角色标记`);
check('关系图谱渲染', (await page.locator('svg').count()) > 0);
await shot('01-workspace');

// 2. requirements list
await page.click('text=需求队列');
await page.waitForTimeout(800);
check('需求队列页', (await page.locator('h1:has-text("需求队列")').count()) > 0);
await shot('02-requirements');

// 3. requirement detail
await page
  .locator('button:has-text("订单")')
  .first()
  .click()
  .catch(() => {});
await page.waitForTimeout(1200);
const detailTitle = await page
  .locator('h1')
  .first()
  .innerText()
  .catch(() => '');
check('需求详情页', detailTitle.length > 0, detailTitle);
await shot('03-requirement-report');

// 4. code tab (a demo/fresh install may open a requirement that has no code yet)
const codeTab = page.locator('button:has-text("代码改动")');
const hasCode =
  (await page.locator('text=改动统计').count()) > 0 || (await codeTab.innerText().catch(() => '')).includes('文件');
if (await codeTab.count()) {
  await codeTab.first().click();
  await page.waitForTimeout(700);
  await shot('04-requirement-diff');
  check(
    '代码改动页',
    !hasCode || (await page.locator('text=改动统计').count()) > 0,
    hasCode ? '' : '该需求暂无代码改动，跳过断言',
  );
}

// 5. acceptance tab
const accTab = page.locator('button:has-text("验收结论")');
if (await accTab.count()) {
  await accTab.first().click();
  await page.waitForTimeout(700);
  await shot('05-requirement-acceptance');
}

// 6. activity
const logTab = page.locator('button:has-text("执行日志")');
if (await logTab.count()) {
  await logTab.first().click();
  await page.waitForTimeout(500);
  await shot('06-requirement-activity');
}

// 7. history
await page.click('nav >> text=已完成');
await page.waitForTimeout(800);
check('历史页', (await page.locator('h1:has-text("已完成历史")').count()) > 0);
await shot('07-history');

// 8. settings
await page.click('nav >> text=设置');
await page.waitForTimeout(800);
check('设置页', (await page.locator('h1:has-text("设置")').count()) > 0);
await shot('08-settings');

// 9. repo picker modal
await page.click('nav >> text=工程与架构');
await page.waitForTimeout(600);
await page.click('text=添加工程');
await page.waitForTimeout(1200);
check('工程选择器弹窗', (await page.locator('text=选择 Git 工程目录').count()) > 0);
await shot('09-repo-picker');

check(
  '无控制台错误',
  errors.filter((e) => !/favicon|Failed to load resource: the server responded with a status of 404/.test(e)).length ===
    0,
  errors.slice(0, 5).join(' | '),
);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
