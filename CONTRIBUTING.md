# 贡献指南

感谢你对 ShadeKit 的关注。参与前请阅读[行为准则](CODE_OF_CONDUCT.md)；安全漏洞请走 [SECURITY.md](SECURITY.md) 的私密渠道，勿开公开 Issue。

## 环境要求

- Node.js 20+（CI 使用 Node 20）
- npm

## 本地开发

```bash
npm install          # 安装依赖（postinstall 自动执行 wxt prepare）
npm run dev          # Chrome 开发模式（dev:firefox / dev:edge 对应其他浏览器）
```

开发模式不会自动拉起浏览器（`webExt.disabled`），需手动加载：

1. 打开 `edge://extensions/` 或 `chrome://extensions/`
2. 开启「开发者模式」→「加载已解压的扩展程序」
3. 选择 `.output/chrome-mv3` 目录

## 常用命令

| 命令 | 用途 |
|------|------|
| `npm run check` | vue-tsc 类型检查 |
| `npm run lint` | Biome 代码检查 |
| `npm run format` | Biome 格式化 |
| `npm run test` | Vitest 单元测试 |
| `npm run build` / `build:edge` | 构建 Chrome / Edge 版本 |
| `npm run zip` / `zip:edge` | 打包商店 zip |
| `npm run release` | 双商店发布（**仅维护者**，需 `.env` 发布凭证，见 `.env.example`） |

提交 PR 前请确保 `check`、`lint`、`test` 全部通过——CI 会执行同样三道关卡加构建。

## 分支模型

- `master` — 主干，PR 目标分支
- `feature/*` — 功能分支
- `v*` — 版本线分支（如 `v1.1.4`）

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：`feat:` / `fix:` / `docs:` / `refactor:` / `perf:` / `test:` / `chore:` / `ci:` / `build:`。

## 添加一个新工具

1. 创建 `entrypoints/tools/{tool-id}/`，包含 `Config.vue` 和可选的 `Popup.vue`
2. 如需独立标签页，创建 `entrypoints/{tool-id}/`（`main.ts`、`App.vue`、`index.html`）
3. 在 `entrypoints/shared/tool-definitions.ts` 的 `allTools` 注册表中声明

架构决策与领域术语请先查阅 [CONTEXT.md](CONTEXT.md) 与 [docs/adr/](docs/adr/)，新模块命名应先查词汇表，避免引入已废弃的模式（词汇表末尾有清单）。
