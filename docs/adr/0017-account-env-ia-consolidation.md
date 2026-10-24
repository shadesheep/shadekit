# ADR-0017: 环境与账号 —— 工具合并与信息架构收敛

- **日期**: 2026-10-23
- **状态**: 已接受（三条硬决策已与负责人确认）
- **背景**: 选项页把「我有哪些环境、每个环境有哪些账号、怎么登录」这一条用户目标链切成 4 个 tab、2 个工具、4 个导入入口。走查证据：首次安装落到账号切换但默认 tab 是「使用指南」（435 行快捷键说明）；新建环境要面对 8 个字段 + 998 行登录声明编辑器；新增账号必须填名称/用户名/密码而编辑时不需要密码；账号不勾「关联环境」就在面板里看不见；列表与矩阵每行都有 checkbox 但没有任何批量动作；`env-indicator` 的配置页空态写「请先在『账号切换』中配置环境」——两个工具互相指路。本地交互原型验证了「环境为一级、账号为行内条目」的可读性。
- **范围**: `entrypoints/tools/account-switch/`、`entrypoints/tools/env-indicator/`（删除）、`entrypoints/shared/tool-definitions.ts`、`entrypoints/shared/tool-config.ts`、`entrypoints/shared/tool-state.ts`、`entrypoints/content/index.ts`、`entrypoints/options/`、`scaffolds/strategy/`、`docs/glossary.md`、`CONTEXT.md`。不改其他工具的内部逻辑。
- **关联**: ADR-0001（入口收敛 / 效率优先）、ADR-0007（Config Kit 与 Auto-save）、ADR-0014 D8/D9（生成 Skill 是签名知识的交付渠道，不提供内置预设）、ADR-0015 D9/D11（配置包边界）、ADR-0016（WebDAV 同步载荷白名单）。

---

## 决策

### D1. `env-indicator` 不再是一个工具，而是环境列表的一个视图

- **决策**: 删除 `env-indicator` 的 ToolDefinition、侧栏项、配置页与独立配置 key。其配置并入账号切换：
  ```ts
  // AccountSwitchConfig 新增
  envBadge?: {
    enabled: boolean;              // 默认 false（与现 enabledByDefault 一致）
    position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
    whitelist: string[];           // 空 = 全部已配置环境
  }
  ```
  指示器模块（`EnvIndicator.ts`）保留，只改为读一份配置。
- **理由**: 指示器没有自己的领域数据。它展示的就是账号切换的 `domains`（现状已直接读 `devtools-account-switch`），白名单存在另一个 key 里。两个工具 = 两个侧栏项 + 两个开关 + 两个配置页 + 一句跨工具指路文案，成本全在认知上。
- **被否决**:
  - 保留两个工具、只把配置页做成互链 —— 互链不消除「我该在哪个里面配」的问题，只是把问路成本从 1 步变成 2 步。
  - 把 env-indicator 升级为「环境管理主工具」、账号切换引用它 —— 方向反了：用户的主目标是登录账号，环境是达成它的手段。
- **迁移**: `CONFIG_VERSION` 由 1 升到 2；`migrateConfig` 从空实现变为真实迁移（v1 → v2）：读 `devtools-env-indicator` → 写入 `devtools-account-switch.envBadge` → 删除旧 key。`devtools-state['env-indicator']` 并入 `envBadge.enabled`。保留一个版本周期的只读兼容（旧 key 存在且新字段缺失时仍生效），避免降级丢配置。

### D2. 三个对象、两条轴：环境 / 登录策略 / 凭据

- **决策**: 信息架构与导入导出都按**对象**组织，而不是按按钮。三个对象：
  - **环境**（origin）：name / tag / apiBase / 调试跳转 / 指示器开关 —— 半公开
  - **登录策略**（`LoginSpec`）：ops / success / auth / vars —— **可分享**，是生成 Skill 的产出物
  - **凭据**（账号 + 默认密码）：username / password / roles / 绑定 —— **永不分享**
  环境是「策略 + 凭据」的绑定点。导入导出的两条轴：**可分享（策略）** / **私有（凭据）** / **全部（整包）**。
- **命名收敛**（现状三个入口全叫「配置」）：
  - `配置包` → **登录策略包**（格式 `dt-login-config/v1` 不变）
  - `备份整份配置（含账号密码）` → **账号备份**（文案写明含明文密码）
  - 全局 `导入配置 / 导出配置` → **全部工具设置**（跨工具，与账号无关）
- **理由**: 「导入」这件事现在没有主语，用户不知道自己在导入哪个对象，必须先学会「整包 vs 配置包 vs 备份 vs JSON 编辑」四个词才能选对按钮。
- **被否决**: 只把 4 个按钮收敛成 1 个抽屉、保持「按文件类型」分类 —— 按钮数从 4 变 3，但「必须先猜这是哪种包」的心智没变。分类轴错了。

### D3. 删除清单（功能不减，认知减半）

| 删除 | 理由 |
|---|---|
| 矩阵视图 + 列表/矩阵勾选框 | 勾选无任何批量动作（`selectedAccounts` / `selectedDomains` 只用于高亮）；矩阵是同一数据的第二表达 |
| 「面板 Tab 顺序」设置 | 作者视角微设置，占一整张卡片 |
| 设置页的 JSON 编辑 textarea | 与备份/导入重复，且是唯一绕过校验的写入口 |
| 「连续添加」复选框 | 与「粘贴多行」重叠 |
| 独立「使用指南」tab | 改为空态 inline 提示 + 主视图顶部「3 步上手」卡片 |
| 角色自由文本输入（默认收起） | 6 个预设覆盖实际场景 |
| 环境「标签」手输 | 改为 3 个预设 chip（本地/测试/生产）+ 从 host 推断；指示器颜色与 chip 同源，不再靠字符串包含匹配 |

### D4. 默认路径是 1 环境 1 账号

- **决策**: 主视图以**环境**为一级，账号是环境卡内的行。多对多（一个账号挂多个环境）保留为能力，但不是默认路径。
- **默认值修正**:
  - 新建环境只填 URL，名称/tag/登录策略自动派生，其余字段收进「高级」折叠
  - 新建账号只需「用户名/密码」一个输入，名称默认 = 用户名，角色留空，环境 = 当前卡
  - 新增与编辑的校验规则对齐（现在新增要求密码、编辑不要求）
  - 老环境 `loginMethod` 为空时回落 `generic`，不再隐式选择旧内置 API 登录
- **被否决**: 引入账号「模板」（`domains: []` 作为可复用凭据）—— 多一层概念，且未绑定账号的语义（面板不显示）已足够表达。

### D5. `scaffolds/strategy` 改为生成 LoginSpec（已于 2026-10-23 移除）

- **决策**: 脚手架从「生成 `implements LoginStrategy` 的 TS 类」改为「生成 `LoginSpec` JSON」，与 ADR-0014 D1（删除 `LoginStrategy` 接口）一致，并为生成 Skill 预先定义产出格式。
- **理由**: 现有脚手架生成的是**将被删除的接口**，站在废弃的 seam 上；同时它是 Skill 产出物的天然落点——Skill 问答产出的就是一份 spec。
- **后果**: 脚手架不再需要用户改 `strategies/index.ts` 注册。ADR-0014 D8「不提供内置签名预设」不变：脚手架产出的是**空骨架 + 注释**，签名组合仍由用户/Skill 决定。
- **后续（2026-10-23）**: 生成 Skill（`login-spec-builder`）已能直接产出填好的完整声明，空骨架脚手架的独立价值消失，`scaffolds/strategy/`、`npm run create-strategy` 及其测试已删除。本决策保留作为历史记录。

---

## 后果

### 正面

- 侧栏少一项，账号切换的 tab 从 4 → 2（主视图 + 配置）
- 新用户三步可通：粘贴一行 → 面板点账号 → `Alt+Shift+A`
- 导入导出从「4 个同类按钮」变成「3 个有主语的对象」
- 「环境指示器」不再需要向另一个工具指路

### 负面 / 风险

- **不可逆的 key 删除**：`devtools-env-indicator` 删除后，旧版本扩展无法读回自己的指示器配置。缓解：只读兼容保留一个版本周期。
- **`CONFIG_VERSION` 首次真正生效**：`migrateConfig` 至今是空实现（`tool-config.ts`），这次是它第一次承担真实迁移，需要单独的迁移测试。
- **主视图重构是本次最大一块**：`Config.vue`（2141 行）与 `DomainsPanel.vue`（约 1000 行）都要动，与 D3 的删除清单在同一批文件，需串行推进以免冲突。

## 相关

- 交互走查与原型记录属于本地开发材料，不随公开仓库分发。
- 词条：`CONTEXT.md`、`docs/glossary.md`（新增「环境」「登录策略」「凭据」三条，`env-indicator` 移入已废弃）
