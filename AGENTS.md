# AGENTS.md

本文件为 AI 编码助手（Claude Code / Codex 等）在此仓库中工作时提供指引。`CLAUDE.md` 是指向本文件的软链接，统一以此文件为准。

## 项目概述

**ShadeKit** — 面向开发/测试的浏览器工具箱扩展，提供账号切换、JSON 格式化、代码美化、模拟数据、环境指示等开发者工具。

- **框架**: WXT (Web Extension Toolkit) + Vue 3 (Composition API)
- **样式**: UnoCSS (原子化 CSS) + content script 专用 SCSS
- **状态**: Vue 内使用 Pinia，扩展持久化使用 `chrome.storage.local`
- **语言**: TypeScript，strict 模式

## 目录结构

```
entrypoints/
├── background.ts              # 扩展后台（消息路由、右键菜单、快捷键）
├── content/                   # 注入网页的 Content Script
│   ├── index.ts               # Dock 渲染、面板管理（暗色不影响宿主页面）
│   └── style.scss             # Content Script 样式（dock、面板、暗色模式）
├── popup/                     # 点击扩展图标弹出的面板
│   ├── main.ts
│   └── App.vue
├── options/                   # 选项页（工具配置管理）
│   ├── main.ts
│   ├── App.vue
│   ├── components/            # ToolMarket.vue 等
│   └── tool-registry.ts
├── shared/                    # 共享模块
│   ├── types.ts               # ToolDefinition、ToolAction 等类型定义
│   ├── tool-definitions.ts    # 统一工具注册表（所有工具的元数据）
│   ├── tool-config.ts         # chrome.storage.local 读写辅助函数
│   ├── tool-state.ts          # 工具启用/禁用状态管理
│   ├── use-theme.ts           # 主题管理（light/dark/system）
│   └── use-toast.ts           # Toast 通知 composable
├── tools/
│   ├── account-switch/        # 账号切换工具（含环境指示器，ADR-0017）
│   ├── json-formatter/        # JSON 格式化
│   ├── json-diff/             # JSON 对比
│   ├── image-base64/          # 图片 ↔ Base64 转换
│   ├── code-beautify/         # 代码美化（JS/CSS/HTML/XML/SQL）
│   └── mock-data/             # 中文测试数据批量生成（JSON/CSV/SQL 导出）
└── {tool-entry}/              # 独立工具标签页
    ├── main.ts
    ├── App.vue
    └── index.html
```

## 核心架构

### 工具注册机制

所有工具在 `entrypoints/shared/tool-definitions.ts` 中通过 `ToolDefinition` 接口声明：

- **id**: 唯一标识
- **popupAction**: 在 Popup 下拉列表中显示
- **openInTab**: 在新标签页中打开
- **contentScript**: 注入网页（Dock + 面板）
- **configSection**: 在选项页侧边栏显示
- **backgroundHandlers**: 后台消息处理
- **defaultConfig**: 默认配置值

### 添加工具的步骤

1. 创建 `entrypoints/tools/{tool-id}/` 目录，包含 `Config.vue` 和可选的 `Popup.vue`
2. 如需独立标签页，创建 `entrypoints/{tool-id}/` 目录，包含 `main.ts`、`App.vue`、`index.html`
3. 在 `entrypoints/shared/tool-definitions.ts` 中注册工具

### 存储约定

- 各工具配置存储在 `chrome.storage.local` 中，key 格式为 `devtools-{toolId}`（见 `entrypoints/shared/tool-config.ts`）
- 工具启用/禁用状态存储在 `devtools-state` key（见 `entrypoints/shared/tool-state.ts`）
- 主题偏好存储在 `devtools-theme` key（见 `entrypoints/shared/use-theme.ts`）

## 常用命令

```bash
# 开发模式
npm run dev           # Chrome（默认）
npm run dev:firefox   # Firefox
npm run dev:edge      # Edge

# 构建
npm run build         # Chrome
npm run build:edge    # Edge
npm run zip:edge      # 打包为 zip

# 类型检查
npm run check         # vue-tsc --noEmit
```

### 加载扩展

1. 打开 `edge://extensions/` 或 `chrome://extensions/`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `.output/chrome-mv3` 目录（开发模式自动生成）

## 技术栈

- **jsencrypt**: RSA 加密
- **CodeMirror 6**: JSON 编辑器（formatter/diff 工具）
- **fast-json-patch**: RFC 6902 JSON Patch（diff 工具）
- **json-source-map**: JSON 路径映射
- **js-beautify**: 代码美化库
- **UnoCSS**: Preset Uno + Lucide 图标，`dark: { dark: '[data-dt-dark]' }` 模式

## 快捷键

- `Alt+Shift+A`: 快速打开账号切换面板（在 manifest `commands` 中定义）

## 开发约定

- 路径别名 `~shared` 映射到 `entrypoints/shared`
- Vue 组件使用 Composition API + `<script setup>`
- Content script 样式使用 SCSS；Vue 组件内使用 UnoCSS 原子类
- 暗色模式通过 `data-dt-dark` 属性控制（不使用 `@media` 查询）

## UI 设计风格

### 色彩体系
- **主色**: indigo→blue 渐变 (`#6366f1` → `#3b82f6`)，用于按钮、激活态、侧边栏高亮
- **成功**: `#16a34a`(亮) / `#4ade80`(暗)
- **错误**: `#dc2626`(亮) / `#f87171`(暗)
- **信息**: `#3b82f6`(亮) / `#60a5fa`(暗)
- **文字层级**: 主文本 `#0f172a` / `#f1f5f9`(暗) · 次要 `#64748b` / `#8b949e`(暗) · 提示 `#94a3b8`
- **边框**: `#e2e8f0`(亮) / `#30363d`(暗)
- **背景**: `#fff`(亮) / `#161b22`(暗 surface) / `#0f172a`(暗 deep) / `#21262d`(暗 hover)
- **角色标签语义色**: 角色色走 ACCOUNT_COLORS 10 色池哈希（`tools/account-switch/account-palette.ts`），预设 3 角色名（ROLE_NAMES）

### 组件规范
- **按钮**: `.btn-primary`(渐变主色+shadow), `.btn-secondary`(边框), `.btn-danger`(红色)
- **输入框**: 1px 边框 + 圆角 6px, focus 时 `0 0 0 2px rgba(99,102,241,0.1)` ring
- **卡片**: border-radius 10-12px, `box-shadow: 0 1px 3px`, hover 时 `translateY(-1px)` + 边框高亮
- **Toggle Switch**: 38×20px, 默认 `#cbd5e1`/`#475569`(暗), 激活时渐变 + glow shadow
- **标签/徽章**: pill 圆角(`9999px`), `.role-pill`(走 account-palette 10 色池), `.env-tag`(灰色), `.role-chip`(可选)
- **Tabs**: `.tab-btn` pill 样式, 激活时渐变背景 + 白色文字 + shadow
- **主题切换**: `.theme-switcher` segmented control, 激活时白底 + 投影
- **Toast**: `.toast-item` 右上角固定, success/error/info 三色
- **工具图标**: popup/ToolMarket 按 tool.id 着语义色（design-tokens.css `--tool-*`）

### 暗色模式
- 通过 `data-dt-dark` 属性控制（不使用 `@media` 查询）
- 全局覆盖: `entrypoints/shared/dark-mode.css`（使用 `!important` 确保优先级）
- UnoCSS 配置为 `dark: ['attribute', 'data-dt-dark']`，`dark:xxx` 工具类自动生成 `[data-dt-dark]` 选择器
- Vue 组件内使用 `[data-dt-dark] .class` 选择器覆盖 scoped 样式
- 语义标签在暗色模式下使用深色底 + 亮色文字（如 `#1e3a5f` 底 + `#93c5fd` 文字）

### 动效与交互
- 过渡: `transition: all 0.15s/0.2s ease-out`
- Hover: `translateY(-1px)` + 边框变色 + shadow 加深
- Active: `scale(0.95)` 或 `scale(0.98)` 按下反馈
- 毛玻璃: `backdrop-filter: blur(12px)` + rgba 半透明背景（Dock、面板）
- 关闭按钮旋转: `transform: rotate(90deg)`

### 图标
- Lucide icon fonts 通过 UnoCSS: `i-lucide-{name} w-{size} h-{size}`
- 常用图标: settings, chevron-left/right, download, upload, plus, pencil, trash-2, globe, users, code

### 文件职责
- `entrypoints/shared/dark-mode.css` — 全局暗色覆盖样式（`!important`，仅 extension 页面）
- `entrypoints/shared/components/` — 独立工具标签页共享组件（`DtButton` / `DtPanel` / `DtEmptyState`）
- `entrypoints/shared/config/` — Config Kit：选项页配置表单套件（ADR-0007）。`DtConfigHeader` / `DtConfigItem` / `DtSegmented` / `DtToggle` / `DtNumberField` / `DtConfigActions` + `useToolConfig`（watch 自动保存）；Config.vue 只组装 Setting Item，不写裸表单元素
- `entrypoints/shared/lib/codemirror-editor.ts` — CodeMirror 装配工厂（`createCodeEditor` / `attachFileDrop`，主题同步与 Mod-Enter 收口，ADR-0003 D3）
- `entrypoints/shared/page-styles.scss` — 独立工具标签页共享布局样式（page-wrapper / top-bar / content-area / drop-overlay 等，各页 main.ts 引入）
- `entrypoints/content/style.scss` — Content script 专用 SCSS（`[data-dt-dark]` 属性标识暗色）
- `entrypoints/shared/use-theme.ts` — 主题模式管理（system/light/dark）
- `entrypoints/shared/ToastContainer.vue` — 全局 Toast 组件（无 Teleport，跟随容器主题）
- Vue 组件内 `<style scoped>` — 各组件自身样式，暗色用 `[data-dt-dark] .class` 覆盖
- `entrypoints/tools/account-switch/SwitcherPanel.vue` — 内容脚本组件，暗色用 `[data-dt-dark] .class`
