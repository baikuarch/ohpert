import fs from 'node:fs';
import path from 'node:path';
import type { ApiCallSite, ApiRouteSite, RepoLink, RepoProfile, RepoRecord, RepoRole, SourceFile } from '../types.js';
import { git } from '../lib/git.js';
import { languageOf, readSource, relOf, walkFiles } from '../lib/fs-scan.js';
import { normalizeEndpoint } from '../lib/endpoint.js';

const FRAMEWORK_RULES: { name: string; test: RegExp; files?: string[] }[] = [
  { name: 'React', test: /"react"\s*:/ },
  { name: 'Vue', test: /"vue"\s*:/ },
  { name: 'Angular', test: /"@angular\/core"\s*:/ },
  { name: 'Svelte', test: /"svelte"\s*:/ },
  { name: 'Next.js', test: /"next"\s*:/ },
  { name: 'Nuxt', test: /"nuxt("\s*:|\s*")/ },
  { name: 'Vite', test: /"vite"\s*:/ },
  { name: 'Express', test: /"express"\s*:/ },
  { name: 'NestJS', test: /"@nestjs\/core"\s*:/ },
  { name: 'Koa', test: /"koa"\s*:/ },
  { name: 'Fastify', test: /"fastify"\s*:/ },
  { name: 'Hono', test: /"hono"\s*:/ },
  { name: 'Spring Boot', test: /spring-boot/ },
  { name: 'Django', test: /^django|Django==/im },
  { name: 'Flask', test: /Flask==|"flask"/i },
  { name: 'FastAPI', test: /fastapi/i },
  { name: 'Gin', test: /gin-gonic\/gin/ },
  { name: 'Echo', test: /labstack\/echo/ },
  { name: 'Fiber', test: /gofiber\/fiber/ },
  { name: 'Actix', test: /actix-web/ },
  { name: 'Axum', test: /axum\s*=/ },
  { name: 'Rails', test: /rails\s*\(|"rails"/ },
  { name: 'Laravel', test: /laravel\/framework/ },
  { name: 'TailwindCSS', test: /"tailwindcss"\s*:/ },
  { name: 'Element Plus', test: /"element-plus"\s*:/ },
  { name: 'Ant Design', test: /"antd"\s*:/ },
  { name: 'Axios', test: /"axios"\s*:/ },
  { name: 'TypeORM', test: /"typeorm"\s*:/ },
  { name: 'Prisma', test: /"prisma"\s*:/ },
  { name: 'MyBatis', test: /mybatis/i },
  { name: 'MyBatis-Plus', test: /mybatis-plus/i },
  { name: 'JPA/Hibernate', test: /spring-boot-starter-data-jpa|hibernate/i },
  { name: 'SQLAlchemy', test: /sqlalchemy/i },
  { name: 'GORM', test: /gorm\.io/ },
];

const FRONTEND_HINTS = [
  'react',
  'vue',
  'svelte',
  'angular',
  '@angular',
  'next',
  'nuxt',
  'vite',
  'webpack',
  'tailwindcss',
  'element-plus',
  'antd',
  'vuetify',
  'sass',
  'less',
];
const BACKEND_HINTS = [
  'express',
  'koa',
  'nestjs',
  '@nestjs',
  'fastify',
  'hono',
  'spring-boot',
  'spring-web',
  'django',
  'flask',
  'fastapi',
  'gin',
  'fiber',
  'echo',
  'actix',
  'axum',
  'rails',
  'laravel',
  'mybatis',
  'hibernate',
  'jdbc',
];

export interface RepoFacts {
  record: RepoRecord;
  profile: RepoProfile;
  /** source files kept in memory for link analysis (limited count) */
  samples: SourceFile[];
}

function readMaybe(root: string, rel: string): string | null {
  try {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > 600_000) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function parsePackageJson(text: string | null) {
  if (!text) return null;
  try {
    return JSON.parse(text) as {
      name?: string;
      description?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      workspaces?: unknown;
    };
  } catch {
    return null;
  }
}

function parseMavenDeps(text: string | null): Record<string, string> {
  if (!text) return {};
  const out: Record<string, string> = {};
  const re = /<dependency>([\s\S]*?)<\/dependency>/g;
  let m;
  while ((m = re.exec(text))) {
    const g = m[1];
    const a = /<artifactId>(.*?)<\/artifactId>/.exec(g)?.[1];
    const v = /<version>(.*?)<\/version>/.exec(g)?.[1];
    if (a) out[a] = v ?? 'managed';
  }
  return out;
}

function parseGradleDeps(text: string | null): Record<string, string> {
  if (!text) return {};
  const out: Record<string, string> = {};
  const re = /(?:implementation|api|compile|runtimeOnly)\s*[( ]\s*['"]([^:'"]+):([^:'"]+)(?::([^'"]+))?['"]/g;
  let m;
  while ((m = re.exec(text))) out[`${m[1]}:${m[2]}`] = m[3] ?? 'managed';
  return out;
}

function parsePythonDeps(text: string | null): Record<string, string> {
  if (!text) return {};
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([A-Za-z0-9_.\-]+)\s*(?:[=<>~!]=*\s*([^;\s]+))?/.exec(t);
    if (m) out[m[1].toLowerCase()] = m[2] ?? '*';
  }
  return out;
}

function parseGoMod(text: string | null): Record<string, string> {
  if (!text) return {};
  const out: Record<string, string> = {};
  const re = /^\s*([a-zA-Z0-9_.\-\/]+\.[a-zA-Z]+\/[^\s]+)\s+(v[^\s]+)/gm;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2];
  return out;
}

function detectPackageManager(root: string, files: string[]): string | null {
  const has = (n: string) => fs.existsSync(path.join(root, n));
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('package-lock.json')) return 'npm';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  if (has('pom.xml')) return 'maven';
  if (has('build.gradle') || has('build.gradle.kts')) return 'gradle';
  if (has('go.mod')) return 'go';
  if (has('Cargo.toml')) return 'cargo';
  if (files.some((f) => /(^|\/)requirements\.txt$|(^|\/)pyproject\.toml$/.test(f))) return 'pip';
  if (has('composer.json')) return 'composer';
  if (has('Gemfile')) return 'bundler';
  return null;
}

/** Generic HTTP call-site detection for the frontend side. */
const FETCH_RE = /fetch\s*\(\s*[`'"]([^`'"]{1,200})[`'"]/g;
const AXIOS_RE =
  /(?:axios|http|request|service|api|client)\s*\.\s*(get|post|put|patch|delete|head|options)\s*(?:<[^>]*>)?\s*\(\s*[`'"]([^`'"]{1,200})[`'"]/gi;
const AXIOS_CFG_RE = /axios(?:\.request)?\s*\(\s*\{[^}]*?url\s*:\s*[`'"]([^`'"]{1,200})[`'"]/g;
const CONST_PATH_RE = /(?:API|URL|BASE|ENDPOINT|PREFIX)[A-Z0-9_]*\s*=\s*[`'"]([\/][^`'"]{1,160})[`'"]/g;

/** Generic route-definition detection for the backend side. */
/**
 * Route detection. Kept as explicit small matchers instead of one mega-regex so
 * each framework convention is easy to verify (and unit-test).
 */
const ROUTE_MATCHERS: ((line: string) => { method: string; path: string } | null)[] = [
  // express / koa / fastify / hono: router.get('/path'), app.post("/path")
  (line) => {
    const m =
      /(?:^|[^\w$.])(?:[A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|del|head|options|all)\s*\(\s*['"`]([^'"`]{1,200})['"`]/.exec(
        line,
      );
    if (!m) return null;
    const method = METHOD_MAP[m[1].toLowerCase()] ?? m[1].toUpperCase();
    return existsSyncSafe(m[2]) ? null : { method, path: m[2] };
  },
  // nest / spring: @GetMapping("/x"), @PostMapping("/y")
  (line) => {
    const m =
      /@(Get|Post|Put|Patch|Delete|Request)Mapping\b(?:\s*\(\s*(?:value\s*=\s*)?(?:path\s*=\s*)?["'`]([^"'`]{0,200})["'`])?/.exec(
        line,
      );
    if (!m) return null;
    return { method: METHOD_MAP[m[1]] ?? 'ANY', path: m[2] ?? '' };
  },
  // spring class-level @RequestMapping("/users") handled as prefix-less route
  (line) => {
    const m = /@(?:\w+\.)?(?:route|get|post|put|delete)\s*\(\s*["'`]([^"'`]{1,200})["'`]/.exec(line);
    if (!m) return null;
    return { method: 'ANY', path: m[1] };
  },
  // flask: @app.route('/x', methods=['POST']) / fastapi: @router.get("/x")
  (line) => {
    const m = /@[\w.]+\.(get|post|put|patch|delete)\s*\(\s*["']([^"']{1,200})["']/.exec(line);
    if (!m) return null;
    return { method: METHOD_MAP[m[1].toLowerCase()] ?? m[1].toUpperCase(), path: m[2] };
  },
  // go net/http & gin-family: HandleFunc("/x"), r.GET("/x"), e.GET("/x")
  (line) => {
    const m = /\.(GET|POST|PUT|DELETE|PATCH|Any|Group)\s*\(\s*["`]([^"`]{0,200})["`]/.exec(line);
    if (!m) return null;
    return { method: m[1] === 'ANY' ? 'ANY' : m[1].toUpperCase(), path: m[2] };
  },
  (line) => {
    const m = /(?:HandleFunc|Handle)\s*\(\s*"([^"]{1,200})"/.exec(line);
    if (!m) return null;
    return { method: 'ANY', path: m[1] };
  },
  // rails: get "/orders/:id" do
  (line) => {
    const m = /^\s*(get|post|put|patch|delete)\s+["']([^"']{1,200})["']/.exec(line);
    if (!m) return null;
    return { method: m[1].toUpperCase(), path: m[2] };
  },
];

function existsSyncSafe(p: string) {
  // heuristics: "/orders/1" style value strings are never file extensions, but
  // asset paths like "/logo.png" are - skip obvious static assets
  return /\.(css|png|jpg|jpeg|svg|gif|js|map|ico|woff2?|ttf|json)$/i.test(p);
}

const METHOD_MAP: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  del: 'DELETE',
  head: 'HEAD',
  options: 'OPTIONS',
  all: 'ANY',
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Request: 'ANY',
};

function lineOf(content: string, index: number) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

function detectApiCalls(files: SourceFile[]): ApiCallSite[] {
  const out: ApiCallSite[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!/\.(tsx?|jsx?|vue|svelte|mjs|cjs)$/.test(f.path)) continue;
    if (/\.(test|spec)\.[tj]sx?$|__tests__|\/mock|fixtures?/.test(f.path)) continue;
    const push = (method: string, p: string, idx: number) => {
      if (!p.includes('/')) return;
      if (p.startsWith('//') || (/^https?:\/\//.test(p) && !/localhost|127\.0\.0\.1/.test(p))) {
        // absolute external urls are noise for cross-repo linking, keep localhost
        if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(p)) return;
      }
      const key = `${method}:${p}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ file: f.path, method, path: p, line: lineOf(f.content, idx) });
    };
    let m: RegExpExecArray | null;
    FETCH_RE.lastIndex = 0;
    while ((m = FETCH_RE.exec(f.content))) {
      const stmtStart = Math.max(0, m.index - 160);
      const near = f.content.slice(stmtStart, m.index + 60);
      const method = /method\s*:\s*['"](\w+)['"]/i.exec(near)?.[1]?.toUpperCase() || 'GET';
      push(method, m[1], m.index);
    }
    AXIOS_RE.lastIndex = 0;
    while ((m = AXIOS_RE.exec(f.content))) push(METHOD_MAP[m[1].toLowerCase()] ?? m[1].toUpperCase(), m[2], m.index);
    AXIOS_CFG_RE.lastIndex = 0;
    while ((m = AXIOS_CFG_RE.exec(f.content))) {
      const near = f.content.slice(m.index, m.index + 240);
      const method = /method\s*:\s*['"](\w+)['"]/i.exec(near)?.[1]?.toUpperCase() || 'GET';
      push(method, m[1], m.index);
    }
    CONST_PATH_RE.lastIndex = 0;
    while ((m = CONST_PATH_RE.exec(f.content))) push('CONST', m[1], m.index);
  }
  return out.slice(0, 400);
}

function detectApiRoutes(files: SourceFile[]): ApiRouteSite[] {
  const out: ApiRouteSite[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!/\.(tsx?|jsx?|mjs|java|kt|kts|py|go|rb|php|cs|rs)$/.test(f.path)) continue;
    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const matcher of ROUTE_MATCHERS) {
        const hit = matcher(line);
        if (!hit) continue;
        if (!hit.path.startsWith('/')) continue;
        const key = `${hit.method}:${hit.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ file: f.path, method: hit.method, path: hit.path, line: i + 1 });
        break;
      }
    }
  }
  return out.slice(0, 600);
}

function detectEnvKeys(files: SourceFile[]): string[] {
  const keys = new Set<string>();
  const re =
    /process\.env\.([A-Z0-9_]{2,})|import\.meta\.env\.([A-Za-z0-9_]{2,})|System\.getenv\(\s*"([A-Z0-9_]{2,})"|os\.environ(?:\.get)?[\[(]\s*["']([A-Z0-9_]{2,})["']|os\.Getenv\(\s*"([A-Z0-9_]{2,})"/g;
  for (const f of files) {
    if (!/\.(tsx?|jsx?|vue|py|go|java|kt|rb|php|rs)$/.test(f.path)) continue;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(f.content))) {
      const k = m[1] || m[2] || m[3] || m[4] || m[5];
      if (k) keys.add(k);
    }
  }
  return [...keys].slice(0, 120);
}

function detectSharedTypes(files: SourceFile[]): string[] {
  const types = new Set<string>();
  const re = /(?:export\s+)?(?:interface|type|enum|class|struct|record)\s+([A-Z][A-Za-z0-9_]{2,40})\b/g;
  for (const f of files) {
    if (!/\.(ts|tsx|java|kt|py|go|cs|rs|dart)$/.test(f.path)) continue;
    if (/\.d\.ts$/.test(f.path)) continue;
    let m;
    while ((m = re.exec(f.content))) types.add(m[1]);
  }
  return [...types].slice(0, 200);
}

export async function profileRepo(record: RepoRecord): Promise<RepoProfile> {
  const root = record.path;
  const allFiles = walkFiles(root, { maxFiles: 40_000 });
  const relFiles = allFiles.map((f) => relOf(root, f));

  const pkg = parsePackageJson(readMaybe(root, 'package.json'));
  const pomText = readMaybe(root, 'pom.xml');
  const gradleText = readMaybe(root, 'build.gradle') || readMaybe(root, 'build.gradle.kts');
  const pyText = readMaybe(root, 'requirements.txt') || readMaybe(root, 'pyproject.toml');
  const goText = readMaybe(root, 'go.mod');

  const pom = parseMavenDeps(pomText);
  const gradle = parseGradleDeps(gradleText);
  const py = parsePythonDeps(pyText);
  const go = parseGoMod(goText);

  const dependencies: Record<string, string> = {
    ...(pkg?.dependencies || {}),
    ...pom,
    ...gradle,
    ...py,
    ...go,
  };
  const devDependencies: Record<string, string> = { ...(pkg?.devDependencies || {}) };

  const depBlob = [
    JSON.stringify(dependencies),
    JSON.stringify(devDependencies),
    pomText ?? '',
    gradleText ?? '',
    pyText ?? '',
    goText ?? '',
    readMaybe(root, 'composer.json') ?? '',
    readMaybe(root, 'Gemfile') ?? '',
  ].join('\n');

  const frameworks = FRAMEWORK_RULES.filter((r) => r.test.test(depBlob)).map((r) => r.name);

  // languages by file count
  const languages: Record<string, number> = {};
  for (const f of relFiles) {
    const lang = languageOf(f);
    if (lang) languages[lang] = (languages[lang] || 0) + 1;
  }

  // samples: pick source files, biased to src/ and entry-ish names, capped by size
  const sourceExts = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.vue',
    '.svelte',
    '.java',
    '.kt',
    '.py',
    '.go',
    '.rs',
    '.rb',
    '.php',
    '.cs',
    '.mjs',
    '.cjs',
  ]);
  const priority = (p: string) => {
    let s = 0;
    if (/^(src|app|lib|internal|pkg|server|api|services?|routes?|controllers?)\//.test(p)) s += 6;
    if (
      /(route|router|controller|service|api|client|request|http|model|entity|dto|schema|types?|store|saga|axios)/i.test(
        p,
      )
    )
      s += 4;
    if (/(index|main|app)\.(tsx?|jsx?|py|go|java|kt)$/.test(p)) s += 3;
    if (/\.(test|spec)\./.test(p) || /__tests__|\.stories\./.test(p)) s -= 8;
    if (/(config|setup|mock|fixture)/i.test(p)) s -= 3;
    s -= p.split('/').length * 0.4;
    return s;
  };
  const candidates = relFiles
    .filter((p) => sourceExts.has(path.extname(p).toLowerCase()))
    .map((p) => ({ p, s: priority(p) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p);

  const samples: SourceFile[] = [];
  let budget = 1_200_000;
  for (const p of candidates) {
    if (samples.length >= 450 || budget <= 0) break;
    const s = readSource(root, p, 300_000);
    if (!s) continue;
    samples.push(s);
    budget -= s.size;
  }

  // entry points
  const entryPoints = relFiles
    .filter(
      (p) =>
        /(^|\/)(index|main|app|server|bootstrap|Application|manage)\.(tsx?|jsx?|py|go|java|kt|rb)$/.test(p) ||
        /(^|\/)main\.(go|rs)$/.test(p),
    )
    .slice(0, 12);

  const configFiles = relFiles
    .filter((p) =>
      /(^|\/)(package\.json|tsconfig\.json|vite\.config\.[jt]s|next\.config\.[jt]s|nuxt\.config\.[jt]s|vue\.config\.[jt]s|angular\.json|pom\.xml|build\.gradle(\.kts)?|go\.mod|Cargo\.toml|requirements\.txt|pyproject\.toml|docker-compose\.ya?ml|Dockerfile|composer\.json|Gemfile|application\.(ya?ml|properties)|\.env\.example|README\.md)$/i.test(
        p,
      ),
    )
    .slice(0, 40);

  const apiCalls = detectApiCalls(samples);
  // a detected "route" that is really an outgoing call (same file+path) must not be counted as a server route
  const callSet = new Set(apiCalls.map((c) => `${c.file}::${c.path}`));
  const apiRoutes = detectApiRoutes(samples).filter((r) => !callSet.has(`${r.file}::${r.path}`));
  const envKeys = detectEnvKeys(samples);
  const sharedTypes = detectSharedTypes(samples);

  const headRes = await git(root, ['rev-parse', 'HEAD']);
  const branchRes = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const statusRes = await git(root, ['status', '--porcelain']);

  const loc = samples.reduce((a, s) => a + s.lines, 0);

  const profile: RepoProfile = {
    id: record.id,
    path: root,
    name: record.name,
    role: record.role,
    roleSource: record.roleSource,
    languages,
    frameworks,
    packageManager: detectPackageManager(root, relFiles),
    scripts: pkg?.scripts || {},
    dependencies,
    devDependencies,
    entryPoints,
    apiCalls,
    apiRoutes,
    envKeys,
    sharedTypes,
    configFiles,
    fileCount: relFiles.length,
    loc,
    branch: branchRes.code === 0 ? branchRes.stdout.trim() : '',
    head: headRes.code === 0 ? headRes.stdout.trim() : '',
    dirty: statusRes.code === 0 ? Boolean(statusRes.stdout.trim()) : false,
    analyzedAt: new Date().toISOString(),
    summary: '',
    topTrees: topTrees(relFiles, 14),
  };
  applyMounts(profile, detectMounts(samples));
  profile.summary = buildProfileSummary(profile, pkg?.description ?? '');
  return profile;
}

function topTrees(files: string[], limit: number): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.split('/');
    const key = parts.length > 1 ? parts.slice(0, 2).join('/') : f;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v]) => `${k} (${v})`)
    .join(', ');
}

export function inferRole(profile: RepoProfile, nameHint = ''): RepoRole {
  const deps = Object.keys({ ...profile.dependencies, ...profile.devDependencies }).map((d) => d.toLowerCase());
  const front = deps.filter((d) => FRONTEND_HINTS.some((h) => d.includes(h))).length;
  const back = deps.filter((d) => BACKEND_HINTS.some((h) => d.includes(h))).length;
  const langs = Object.entries(profile.languages).sort((a, b) => b[1] - a[1]);
  const topLang = langs[0]?.[0] ?? '';
  const name = nameHint.toLowerCase();

  const mobile =
    deps.some((d) => ['react-native', 'expo', 'flutter'].includes(d)) || /flutter/.test(profile.packageManager ?? '');
  if (mobile) return 'mobile';

  const infra =
    /(^|\/)(k8s|helm|terraform|deploy|infra|charts?)(\/|$)/.test(profile.topTrees) ||
    (deps.length === 0 && langs.length === 0);
  if (infra && profile.fileCount > 0 && langs.length === 0) return 'infra';

  const backendLang = ['Java', 'Go', 'Python', 'Kotlin', 'C#', 'PHP', 'Ruby', 'Rust'].includes(topLang);
  const routeCount = profile.apiRoutes.length;
  const callCount = profile.apiCalls.length;

  const outboundOnly = callCount > routeCount * 2 + 1;
  const tinyClientWrapper = profile.loc < 400 && callCount > 0 && routeCount === 0;
  const frontScored =
    front * 3 +
    (tinyClientWrapper ? 4 : 0) +
    callCount +
    (outboundOnly ? 6 : 0) +
    (['TypeScript', 'JavaScript', 'Vue', 'Svelte'].includes(topLang) ? 2 : 0) +
    (/web|front|ui|client|portal|admin-app|h5/.test(name) ? 3 : 0);
  const backScored =
    back * 3 +
    routeCount +
    (outboundOnly ? 0 : 2) +
    (backendLang ? 3 : 0) +
    (/api|server|service|backend|gateway|core/.test(name) ? 3 : 0);
  if (front > 0 && back > 0 && Math.abs(frontScored - backScored) <= 2) return 'fullstack';
  if (frontScored > backScored) return 'frontend';
  if (backScored > frontScored) return 'backend';
  if (langs.length === 0) return 'unknown';
  if (/lib|sdk|common|shared|utils|tools|kit|component/.test(name)) return 'library';
  return backendLang ? 'backend' : 'frontend';
}

function buildProfileSummary(p: RepoProfile, pkgDesc: string): string {
  const langs =
    Object.entries(p.languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([l, c]) => `${l}(${c})`)
      .join(' ') || '无源文件';
  const parts = [
    `角色=${p.role}`,
    `主要语言=${langs}`,
    p.frameworks.length ? `框架=${p.frameworks.join('/')}` : '',
    p.packageManager ? `包管理=${p.packageManager}` : '',
    `文件数=${p.fileCount}`,
    `已扫描代码行=${p.loc}`,
    p.apiRoutes.length ? `后端路由=${p.apiRoutes.length}个` : '',
    p.apiCalls.length ? `前端请求点=${p.apiCalls.length}个` : '',
    pkgDesc ? `描述=${pkgDesc.slice(0, 120)}` : '',
    `目录=${p.topTrees}`,
  ].filter(Boolean);
  return parts.join(' | ');
}

/** Collect `app.use('/api/auth', authRouter)` style mounts so nested routers keep their prefix. */
function detectMounts(files: SourceFile[]): { prefix: string; routerVar: string; services: string[] }[] {
  const mounts: { prefix: string; routerVar: string; services: string[] }[] = [];
  for (const f of files) {
    if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(f.path)) continue;
    // service names this file is wired to, e.g. `import { login } from '../services/auth.service.js'`
    const services = [...f.content.matchAll(/from\s+['"][^'"]*?([\w.-]+)\.(?:service|services)[^'"]*['"]/g)].map(
      (m) => m[1],
    );
    for (const line of f.content.split('\n')) {
      const m = /\.(?:use|register|mount)\s*\(\s*['"`](\/[^'"`]{1,120})['"`]\s*,\s*([A-Za-z_$][\w$]*)/.exec(line);
      if (m) mounts.push({ prefix: m[1], routerVar: m[2], services });
    }
  }
  return mounts;
}

/** Merge nested-router mounts onto a repo's route list. */
export function applyMounts(profile: RepoProfile, mounts: { prefix: string; routerVar: string; services: string[] }[]) {
  if (!mounts.length) return;
  const norm = (p: string) => (p === '/' ? '' : p.replace(/\/+$/, ''));
  const base = (p: string) => p.split('/').filter(Boolean).slice(-1)[0]?.toLowerCase() ?? '';

  for (const route of profile.apiRoutes) {
    const fileStem = base(route.file)
      .replace(/\.(service|routes?|controller|handler)$/i, '')
      .replace(/\.(j|t)sx?$/, '');
    const scored = mounts.map((m) => {
      let score = 0;
      // a route file whose name appears in the mount's imports is almost certainly this router
      if (m.services.some((s) => base(s) === fileStem || s.toLowerCase().includes(fileStem))) score += 5;
      if (base(m.prefix) === fileStem) score += 4;
      if (m.routerVar.toLowerCase().replace(/router$/, '') === fileStem) score += 3;
      // fall back to the first path segment of the route ('/login' under '/api/auth')
      if (base(route.path) === base(m.prefix)) score += 1;
      return { m, score };
    });
    const top = Math.max(...scored.map((x) => x.score));
    if (top <= 0) continue;
    const best = scored.filter((x) => x.score === top).map((x) => x.m);
    const merged = new Set<string>();
    for (const c of best) merged.add(`${norm(c.prefix)}${route.path}`);
    merged.add(route.path);
    route.alternates = [...merged];
  }
}

/** Normalise an endpoint path so `/api/user/1` and `/user/:id` can be matched. */
export { normalizeEndpoint };

export function computeLinks(records: RepoRecord[], profiles: Record<string, RepoProfile>): RepoLink[] {
  const links: RepoLink[] = [];
  const repos = records.filter((r) => profiles[r.id]);

  // index every backend route by its path suffixes so '/orders/list' can be
  // reached from '/api/orders/list', '/orders/list' and '/v1/orders/list'
  const routeIndex = new Map<string, { repoId: string; site: ApiRouteSite; fullPath: string }[]>();
  for (const r of repos) {
    const p = profiles[r.id];
    for (const route of p.apiRoutes) {
      const candidates = route.alternates?.length ? route.alternates : [route.path];
      for (const candidate of candidates) {
        const norm = normalizeEndpoint(candidate);
        const segs = norm.split('/').filter(Boolean);
        for (let take = segs.length; take >= 1; take--) {
          const key = '/' + segs.slice(segs.length - take).join('/');
          if (key.length < 4) continue;
          const list = routeIndex.get(key) ?? [];
          if (!list.some((x) => x.repoId === r.id && x.site.path === route.path))
            list.push({ repoId: r.id, site: route, fullPath: candidate });
          routeIndex.set(key, list);
        }
      }
    }
  }

  const methodCompatible = (a: string, b: string) =>
    a === 'ANY' || b === 'ANY' || a === 'CONST' || b === 'CONST' || a === b;

  for (const front of repos) {
    const fp = profiles[front.id];
    if (!fp.apiCalls.length) continue;

    // group this repo's calls by the backend repo they reach
    const perBackend = new Map<
      string,
      { method: string; path: string; backendFile?: string; frontendFiles: string[]; score: number }[]
    >();
    const evidenceByBackend = new Map<string, RepoLink['evidence']>();

    for (const call of fp.apiCalls) {
      const callNorm = normalizeEndpoint(call.path);
      const segs = callNorm.split('/').filter(Boolean);
      let best: { repoId: string; site: ApiRouteSite; fullPath: string; score: number } | null = null;
      for (let take = segs.length; take >= 1; take--) {
        const key = '/' + segs.slice(segs.length - take).join('/');
        if (key.length < 4) continue;
        for (const hit of routeIndex.get(key) ?? []) {
          if (hit.repoId === front.id) continue;
          if (!methodCompatible(call.method, hit.site.method)) continue;
          const score =
            take * 10 +
            (call.method !== 'CONST' && call.method === hit.site.method ? 5 : 0) +
            (hit.fullPath.toLowerCase() === callNorm ? 8 : 0); // exact literal match beats a prefix
          if (!best || score > best.score) best = { repoId: hit.repoId, site: hit.site, fullPath: hit.fullPath, score };
        }
        if (best && take < segs.length) break; // stop at first (longest) suffix that matched
      }
      if (!best) continue;

      const list = perBackend.get(best.repoId) ?? [];
      const resolvedPath = best.fullPath;
      const existing = list.find((x) => x.path === resolvedPath);
      if (existing) {
        if (!existing.frontendFiles.includes(`${call.file}:${call.line}`))
          existing.frontendFiles.push(`${call.file}:${call.line}`);
        existing.score = Math.max(existing.score, best.score);
      } else {
        list.push({
          method: best.site.method === 'ANY' ? (call.method === 'CONST' ? 'GET' : call.method) : best.site.method,
          path: resolvedPath,
          backendFile: `${best.site.file}:${best.site.line}`,
          frontendFiles: [`${call.file}:${call.line}`],
          score: best.score,
        });
      }
      perBackend.set(best.repoId, list);

      const ev = evidenceByBackend.get(best.repoId) ?? [];
      if (ev.length < 10) {
        ev.push({
          file: `${call.file}:${call.line}`,
          detail: `前端 ${call.method} ${call.path} → 后端 ${best.site.file}:${best.site.line} ${best.site.method} ${resolvedPath}`,
        });
      }
      evidenceByBackend.set(best.repoId, ev);
    }

    for (const [backendId, endpoints] of perBackend) {
      const back = profiles[backendId];
      const sorted = endpoints.sort((a, b) => b.score - a.score);
      links.push({
        id: `http:${front.id}->${backendId}`,
        from: front.id,
        to: backendId,
        kind: 'http-api',
        strength: Math.min(100, 45 + sorted.length * 8),
        summary: `${front.name} 通过 ${sorted.length} 个接口调用 ${back.name}（${sorted
          .slice(0, 4)
          .map((e) => `${e.method} ${e.path}`)
          .join('、')}${sorted.length > 4 ? ' 等' : ''}）`,
        evidence: evidenceByBackend.get(backendId) ?? [],
        endpoints: sorted.map(({ score: _score, ...rest }) => rest).slice(0, 60),
      });
    }
  }

  // shared types
  for (let i = 0; i < repos.length; i++) {
    for (let j = i + 1; j < repos.length; j++) {
      const a = profiles[repos[i].id];
      const b = profiles[repos[j].id];
      const setB = new Set(b.sharedTypes);
      const shared = a.sharedTypes.filter((t) => setB.has(t));
      const meaningful = shared.filter(
        (t) => !/^(Response|Request|Result|Base|Config|Error|Options|Props|State|Item|Data)$/.test(t),
      );
      if (meaningful.length >= 2) {
        links.push({
          id: `types:${repos[i].id}<->${repos[j].id}`,
          from: repos[i].id,
          to: repos[j].id,
          kind: 'shared-types',
          strength: Math.min(100, 20 + meaningful.length * 4),
          summary: `${a.name} 与 ${b.name} 存在 ${meaningful.length} 个同名模型/类型定义：${meaningful.slice(0, 8).join('、')}`,
          evidence: meaningful.slice(0, 8).map((t) => ({ file: t, detail: `类型 ${t} 同时出现在两个工程的源码中` })),
        });
      }
      const envA = new Set(a.envKeys);
      const sharedEnv = b.envKeys.filter((k) => envA.has(k));
      if (sharedEnv.length >= 1) {
        links.push({
          id: `env:${repos[i].id}<->${repos[j].id}`,
          from: repos[i].id,
          to: repos[j].id,
          kind: 'shared-env',
          strength: Math.min(100, 15 + sharedEnv.length * 5),
          summary: `共享环境变量/配置项：${sharedEnv.slice(0, 8).join('、')}`,
          evidence: sharedEnv.slice(0, 8).map((k) => ({ file: k, detail: `环境变量 ${k}` })),
        });
      }
    }
  }

  // npm package: one repo depends on the other's package name
  for (const consumer of repos) {
    const cp = profiles[consumer.id];
    for (const provider of repos) {
      if (provider.id === consumer.id) continue;
      const pkgName = profiles[provider.id].name;
      const deps = { ...cp.dependencies, ...cp.devDependencies };
      if (deps[pkgName]) {
        links.push({
          id: `npm:${consumer.id}->${provider.id}`,
          from: consumer.id,
          to: provider.id,
          kind: 'npm-package',
          strength: 80,
          summary: `${consumer.name} 以依赖 ${pkgName}@${deps[pkgName]} 的方式引用 ${provider.name}`,
          evidence: [{ file: 'package.json', detail: `${pkgName}@${deps[pkgName]}` }],
        });
      }
    }
  }

  // same domain heuristics: repos whose top source roots overlap strongly
  for (let i = 0; i < repos.length; i++) {
    for (let j = i + 1; j < repos.length; j++) {
      const a = profiles[repos[i].id];
      const b = profiles[repos[j].id];
      const rootsA = a.topTrees
        .split(', ')
        .slice(0, 6)
        .map((x) => x.replace(/\s*\(\d+\)$/, ''));
      const rootsB = b.topTrees
        .split(', ')
        .slice(0, 6)
        .map((x) => x.replace(/\s*\(\d+\)$/, ''));
      let bestShared = '';
      for (const ra of rootsA) {
        for (const rb of rootsB) {
          if (ra === rb && ra.split('/').length >= 2) bestShared = ra;
        }
      }
      const prefix = bestShared ? bestShared.split('/').length : 0;
      if (prefix >= 2) {
        links.push({
          id: `domain:${repos[i].id}<->${repos[j].id}`,
          from: repos[i].id,
          to: repos[j].id,
          kind: 'same-domain',
          strength: 30,
          summary: `两工程共享相近的目录/业务域命名（${bestShared}）`,
          evidence: [{ file: bestShared, detail: '目录结构相似' }],
        });
      }
    }
  }

  return links.sort((x, y) => y.strength - x.strength);
}
