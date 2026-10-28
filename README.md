# ohpert · AI 需求研发平台

> 选择多个 Git 工程（前端 / 后端 …）→ AI 摸清它们之间的关系 → 输入需求 → AI 出影响面报告 → AI 改代码 → AI 验收 → 你点确认 → 进入历史。

ohpert 是一个**本地优先**的「多仓库需求交付平台」：它把一句需求推进到可回滚的真实代码改动，
每一步都留下可核对的证据（接口清单、文件级 diff、自动化检查输出、验收评分）。

```
┌─────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ 选择工程 │ → │ 架构分析  │ → │ 需求报告  │ → │ AI 研发   │ → │ AI 验收   │ → 你确认 → 历史
│ (多 git) │   │ (关系图谱)│   │ (影响面) │   │ (改代码)  │   │ (评分)   │
└─────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
   静态扫描        静态+LLM        LLM           工具调用循环      自动化+LLM
```

> 项目处于早期阶段（0.x），接口与数据结构仍可能调整。欢迎通过 issue / PR 参与。

---

## 快速开始

环境：Node.js ≥ 22.5（使用内置 `node:sqlite`）、pnpm、系统 `git`。

```bash
# 1. 安装依赖
pnpm install

# 2. 开发模式（同时启动 API:5274 与 Web:5273，带热更新）
pnpm dev

# 或者：生产模式（构建前端并由后端统一托管，默认 http://127.0.0.1:5274）
pnpm build && pnpm start
```

打开 <http://127.0.0.1:5273>（开发模式）。

### 配置模型

设置页 → **AI 模型**，填写任意 OpenAI 兼容的 `Base URL` / `API Key`，然后：

1. 页面会自动调用网关的 `GET {BaseURL}/models` 拉取**模型列表**（顶部会显示「已获取 N 个模型」）。
2. 「默认模型 / 需求分析模型 / 编码模型 / 验收模型」都是**下拉选择**：可直接搜索、点击选中。
3. 列表里没有的模型，选「自定义输入模型 ID」或在搜索框里输入后回车即可**自由填写**。
4. 修改 Base URL 或 API Key 后点「获取模型列表」重新拉取；点「测试连接」验证可用性。

> 列表获取失败不会阻塞配置——仍可手动输入模型 ID，错误原因会显示在选择器里。
> 认证失败时可按需在网关侧放行 `/models` 端点。

也可以通过环境变量注入（应用内设置优先；环境变量在对应设置留空时生效）：

| 变量                                      | 说明                              |
| ----------------------------------------- | --------------------------------- |
| `OHPERT_LLM_BASE_URL` / `OPENAI_BASE_URL` | 例如 `https://api.openai.com/v1`  |
| `OHPERT_LLM_API_KEY` / `OPENAI_API_KEY`   | 密钥                              |
| `OHPERT_LLM_MODEL`                        | 默认模型                          |
| `OHPERT_DATA_DIR`                         | 数据目录（默认 `./.data`）        |
| `PORT`                                    | API 端口（默认 5274）             |
| `OHPERT_SEED_DEMO`                        | 设为 `0` 可关闭首次启动的演示数据 |

> 需要支持 **function calling** 的模型（需求研发阶段依赖工具调用）。可为「分析 / 编码 / 验收」分别指定模型。
> 仓库提供了一个不包含任何密钥的 [`.env.example`](.env.example)，按需复制为 `.env` 并由你的 shell 加载。

### 想先试用？

首次启动（空数据目录）会自动载入**演示数据**：把 `samples/` 下的三个示例工程
（`ohpert-api` 后端、`ohpert-web` 前端、`ohpert-admin` 管理端）复制到 `.data/demo-repos/`，
建立本地 Git 历史，再附上一份架构图谱、一条已完成的需求和一条待处理需求。
无需 API Key 即可浏览界面；配置模型后可以直接在示例工程上体验研发与验收。

- 示例工程以普通目录随仓库提供，**不是 submodule**，克隆后即可使用。
- 演示数据只写入 `.data/`，不会改动仓库里的 `samples/`。
- 设置 `OHPERT_SEED_DEMO=0` 可关闭自动演示数据；`POST /api/demo/seed` 可随时重新载入。

---

## 五个步骤

### 1. 选择工程 & AI 架构分析

- 「添加工程」提供目录浏览器（可搜索、多选），只接受 **Git 仓库根目录**。
- 点击「AI 分析架构」后：
  1. **静态扫描**每个工程：语言分布、框架（Express/Vue/React/Spring…）、包管理器、脚本、入口文件、环境变量、
     领域模型，以及**前端请求点**（`fetch/axios` 等）和**后端路由**（Express/Nest/Spring/Flask/FastAPI/Gin…）。
  2. **跨工程关联**：把前端调用与后端路由做归一化匹配（自动补全 `app.use('/api/xxx', router)` 挂载前缀），
     再叠加共享类型、共享环境变量、npm 包依赖、同域目录等线索，形成带证据的关联边。
  3. **LLM 汇总**：生成架构说明、业务域划分、关键链路与风险提示（如 CORS、接口前缀不一致、悬空调用）。
- 界面呈现：工程卡片（角色可手动纠正）+ 可交互的关系图谱（按关联强度/类型着色，点击查看代码级证据）。

### 2. 输入需求 → 队列 → 需求报告

- 「录入需求」支持模板；提交后进入**队列**，AI 按队列顺序自动分析（同一时间只跑一个，避免资源争抢）。
- 报告包含：摘要/目标/验收标准、**影响面**（每个工程的影响等级、理由、涉及模块与真实文件路径）、
  **接口变更清单**（方法/路径/新增或修改）、**前端修改范围**、**后端修改范围**、数据模型变化、风险、测试计划、工作量估算、假设与范围外事项。

### 3. 开始研发（AI 改代码）

- 每个受影响工程都会创建一个**独立 `git worktree` 副本**并切到 `ohpert/req-<序号>-<slug>` 分支。
  如果 worktree 无法创建（例如 `.git` 不可写），任务会带着可操作的错误信息失败，**不会**退回到你的主检出目录改代码。
- 工作区会自动链接工程里被 `.gitignore` 忽略的 `node_modules`，并复制被忽略的 `.env*` 文件；
  因为只处理忽略路径，平台的自动 `git add -A` 不会把依赖或密钥提交进分支。
- AI 在一个有界工具循环里工作：`list_dir / read_file / search_code / edit_file / write_file / delete_file / run_command / switch_repo`，
  每次工具调用都会实时显示在「执行日志」中。
- 安全护栏：路径必须落在工程目录内（含符号链接解析）；`run_command` 按命令片段检查，
  拒绝 `git commit/push/reset`、装包（`npm install`/`pnpm add`/`npx` 自动下载…）、`sudo`、`rm`、网络工具等危险操作。
- 结束后平台自动 `git commit`，并解析 `git diff` 生成**文件级改动清单 + 完整 patch**。

### 4. 验收

分两层：

1. **自动化检查**（不依赖模型）：存在真实代码改动、改动已入库可回滚、无冲突标记/占位代码、
   各工程自动探测并执行 `typecheck/build/lint`（按工程实际使用的 pnpm/yarn/bun/npm 或 mvnw/gradlew 调用；
   失败会把命令与输出一并展示）、接口变更与代码一致性（**按工程分别匹配**，不会把多个仓库拼成一个文本块）。
   验收只会使用研发阶段创建的工作区，并校验其 HEAD 与研发记录一致；工作区丢失或已被改动时会要求重新研发，
   不会在你的主检出目录上误验收。
2. **AI 评审**：把 diff、改动后代码、验收标准、自动化检查结果喂给模型，逐条核对验收标准、
   前后端一致性、接口契约、异常与边界、测试覆盖，输出 `pass / pass_with_notes / fail` 与 0–100 分。

> 判定规则是确定的：有 `fail` 项 → 不通过；只有 `warn` → 通过（有备注）；全 `pass` → 通过。

### 5. 你确认 → 历史

- **确认完成**：需求进入「已完成历史」，保留报告、diff、验收结论与确认备注，可搜索/按工程筛选/导出 JSON。
- **驳回返工**：填写的意见会作为下一轮研发的高优先级输入，需求回到可研发状态（返工次数被记录）。
- 任意阶段都可以**一键回滚**：删除平台分支、清理 worktree，你的 `main` 丝毫不受影响。

---

## 数据、隐私与安全

ohpert 默认在本机运行，没有账号体系，也没有遥测。理解数据流向很重要：

| 数据                       | 位置 / 去向                                              |
| -------------------------- | -------------------------------------------------------- |
| 工程、需求、日志、diff     | 本机 `.data/ohpert.db`（SQLite）                         |
| LLM 配置与 API Key         | 本机 `.data/settings.json`（明文，权限 `0600`）          |
| 研发工作区                 | 本机 `.data/workspaces/<需求ID>/`（临时 `git worktree`） |
| 代码上下文、需求文本、diff | 发送到你配置的 LLM 接口，用于分析、编码与评审            |
| 其它网络请求               | 无；不访问统计、崩溃上报或第三方服务                     |

部署与使用建议：

- `.data/` 使用 `0700`、`settings.json` 使用 `0600`；不要把 `.data/` 提交或分享。
- API Key 以明文保存在本机，请使用可撤销、最小权限的密钥，并保护好系统账户与磁盘。
- 发送给模型的代码与需求可能包含敏感信息；请确认所配置的模型服务满足你的合规要求。
- 本地 API 只监听 `127.0.0.1`，并校验 `Host` / `Origin` / `Sec-Fetch-Site`，防止 DNS rebinding 与跨站调用。
- 目录浏览、目录搜索和添加工程都被限制在设置页配置的「工作区根目录」内。
- 研发使用独立 worktree 与 `ohpert/req-*` 分支；一键回滚只清理平台创建的分支和工作区。

发现安全问题请阅读 [SECURITY.md](SECURITY.md)，**不要**公开提交 issue。

---

## 技术架构

| 层        | 选择                                  | 说明                                                                                |
| --------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| 后端      | Node ≥22.5 + TypeScript + Hono        | `node:sqlite` 持久化，零外部数据库；SSE 实时推送                                    |
| 前端      | React 18 + Vite + Tailwind            | 浅色工作台，图谱用原生 SVG                                                          |
| AI        | 任意 OpenAI 兼容接口                  | 流式输出 + function calling，支持分阶段选模型                                       |
| 版本控制  | 系统 `git`                            | worktree 隔离、分支提交、diff 解析、回滚                                            |
| 测试/校验 | `node:test` + `tsx` + ESLint/Prettier | 单元/集成测试、静态检查与格式化；GitHub Actions 跑 typecheck/lint/format/test/build |

```
server/src
├─ index.ts              # Hono 入口，生产模式托管 SPA
├─ routes.ts             # REST + SSE (/api/events)
├─ types.ts              # 共享领域类型（前后端同名结构）
├─ config.ts             # 路径/忽略规则/端口
├─ store/                # sqlite schema、仓储、设置
├─ lib/                  # git 封装、文件扫描、日志总线、路径/命令防护
├─ analysis/             # 工程画像 + 跨工程关联 + LLM 架构汇总
├─ llm/                  # OpenAI 兼容客户端（流式/JSON/工具）+ 提示词
├─ agents/               # planner（需求报告）、implementer（编码代理）、verifier（验收）、loop/tools
└─ services/             # orchestrator（队列与任务编排）、workspace（worktree/diff/回滚）

web/src
├─ store/app.tsx         # 全局状态 + SSE 订阅 + hash 路由
├─ views/                # 工程与架构 / 需求队列 / 需求详情 / 已完成 / 设置
└─ components/           # 目录选择器、架构图谱、diff 查看器、通用 UI
```

数据都在 `./.data/`：`ohpert.db`（需求/工程/日志）、`settings.json`、`workspaces/<需求ID>/`（研发用的 worktree）。

---

## 开发命令

| 命令                                     | 作用                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm dev`                               | 同时启动 API 与 Web（热更新）                                                       |
| `pnpm build`                             | 构建前端 + 编译后端                                                                 |
| `pnpm start`                             | 生产模式启动（单端口托管）                                                          |
| `pnpm typecheck`                         | 前后端类型检查                                                                      |
| `pnpm test`                              | 单元/集成测试（`node:test`，覆盖路径防护、命令校验、接口匹配、worktree 依赖注入等） |
| `pnpm lint`                              | ESLint（TypeScript + React Hooks）                                                  |
| `pnpm format` / `pnpm format:check`      | Prettier 格式化 / 校验                                                              |
| `pnpm ui-check`                          | 无头浏览器 UI 冒烟测试，截图输出到 `.screenshots/`（自动忽略，不提交）              |
| `pnpm ui-check -- http://127.0.0.1:5274` | 对任意已启动的实例运行 UI 检查                                                      |

`ui-check` 需要本机 Chrome/Chromium；也可以用 `OHPERT_CHROME_PATH` 指定浏览器路径，
或执行 `pnpm exec playwright install chromium` 安装 Playwright 管理的浏览器。

---

## 已知边界

- 需要支持 tool calling 的模型；纯文本模型无法完成研发阶段。
- 单进程执行队列；大规模并行需要引入任务队列（如 BullMQ）。
- 自动探测的构建命令覆盖 Node/Maven/Gradle/Go 常见约定，其它栈可在设置里手动指定。
- 静态关联基于正则与约定推断（不是完整 AST/类型系统），对非常规写法可能漏判；LLM 会补充定性关联。
- 自动化检查只负责可确定的事实（改动存在、可回滚、构建/类型检查等）；最终是否合并仍由你确认。

---

## 参与贡献

- 贡献流程与开发约定：[CONTRIBUTING.md](CONTRIBUTING.md)
- 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 安全策略：[SECURITY.md](SECURITY.md)

## License

[MIT](LICENSE) © ohpert contributors
