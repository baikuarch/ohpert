# 贡献指南

感谢你愿意改进 ohpert。提交代码前，请先阅读下面的约定。

## 环境要求

- Node.js ≥ 22.5（内置 `node:sqlite`）
- pnpm ≥ 10（仓库锁定 `pnpm@11.18.0`）
- 系统 `git`
- 可选：本机 Chrome / Chromium，用于 `pnpm ui-check`

## 本地开发

```bash
pnpm install
pnpm dev            # API: 5274, Web: 5273（热更新）
```

生产模式：

```bash
pnpm build
pnpm start          # 默认 http://127.0.0.1:5274
```

首次启动会从 `samples/` 复制三个示例工程到 `.data/demo-repos/` 并建立本地 Git 历史，
用于在没有 API Key 时浏览界面。设置 `OHPERT_SEED_DEMO=0` 可关闭。

模型配置见 README 的「配置模型」一节；任何支持 function calling 的 OpenAI 兼容接口都可以。

## 提交前检查

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm format:check
```

如果修改了界面，请再跑一次 UI 冒烟测试：

```bash
pnpm dev
pnpm ui-check -- http://127.0.0.1:5273
# 或对生产构建：pnpm start && pnpm ui-check -- http://127.0.0.1:5274
```

## 代码约定

- 保持现有目录结构：后端在 `server/src`，前端在 `web/src`，测试在 `server/test`。
- TypeScript 严格模式；不要用 `any` 绕过类型问题，除非边界处确实需要。
- 用户可见文案目前以中文为主，新增文案请保持一致。
- 网络、文件系统、Git 和命令执行相关改动必须补充测试，重点覆盖：
  - 路径是否仍在工程目录内（含符号链接）；
  - 命令白名单/黑名单是否可绕过；
  - worktree 是否误用了用户的主检出；
  - 失败时是否会留下半成品状态或泄露密钥。
- 新增依赖前请说明理由，并确认许可证兼容 MIT。

## 隐私与示例数据

这是公开仓库，请不要提交：

- 真实公司、客户、项目、仓库或需求名称；
- 本机绝对路径、用户名、邮箱、内网地址或私有网关/模型 ID；
- 真实数据库、`.data/`、`.screenshots/`、`.env` 或任何密钥；
- 由真实数据生成的截图。

示例统一放在 `samples/`，使用虚构的业务与数据。演示数据文件是
`server/demo/sample-demo.json`，其中的路径必须是相对 `samples/` 的路径。

## 提交与 Pull Request

1. 从 `main` 切出分支，提交信息使用简短的祈使句（例如 `fix: reject symlink escapes`）。
2. 一个 PR 只做一件事；行为变化请附上复现步骤或测试。
3. 在 PR 描述中写清楚：改了什么、为什么、如何验证、是否有破坏性变更。
4. 确保 CI（typecheck / lint / format / test / build）通过。

安全问题请不要发公开 issue，见 [SECURITY.md](SECURITY.md)。
