# ADR-0019: 登录策略独立为策略库，环境改为「引用 + 镜像」

- **日期**: 2026-10-23（同日修订：快照 → 镜像）
- **状态**: 已接受
- **背景**: ADR-0017 D2 把「登录策略」定义为可分享的一等对象、环境是「策略 + 凭据」的绑定点，但实现里策略没有自己的位置——它只作为 `DomainConfig.strategyConfig.spec` 寄生在环境上。于是出现两个产品级矛盾：
  1. **导入一份登录策略包必然新增一条环境记录**（`DomainsPanel.confirmImport` 直接 `next[url] = {...}`），即使用户只想把策略存起来以后用；
  2. **策略无法脱离环境存在**，删除环境 = 策略一并消失；同事之间「传一份策略」只能靠传一个环境。
- **范围**: `entrypoints/tools/account-switch/types.ts`、`spec/strategy-library.ts`（新增）、`spec/strategy-presets.ts`、`spec/run.ts`、`config/DomainsPanel.vue`、`config/StrategyLibrary.vue`（新增）、`Config.vue`、`tests/`、`docs/glossary.md`、`docs/login-specs/README.md`。不改 `LoginSpec` 格式、不改执行器 `runSpec` 的算子语义、不改配置包 `dt-login-config/v1` 格式。
- **关联**: ADR-0017 D2（三个对象、两条轴）、ADR-0015 D9/D10（配置包 / 读取链 / 执行只认 spec）。

---

## 决策

### D1. 策略库放在 `devtools-account-switch.strategies`，不新开 storage key

- **决策**: 新增 `AccountSwitchConfig.strategies: Record<string, StrategyEntry>`，其中 `StrategyEntry = { name, spec, createdAt, updatedAt }`。**不为它单独开一个 `chrome.storage.local` key。**
- **理由**:
  - 「全部工具设置」导出与 WebDAV 同步都走**注册表白名单**（`config-transfer.ts` 的 `isExportableConfigId` = `allTools` 的 id）。新开 `devtools-account-switch-strategies` 会被静默漏掉，除非改 `config-transfer`、ADR-0016 的载荷构造与相关测试；同 key 新字段则免费获得备份、同步、导出。
  - 导入策略 + 创建环境需要一次原子写入。`updateConfig` 的读-改-写锁是**按工具 key** 的；两个 key 意味着可产生「库写成功、环境没写」的半成品。
  - 配额是同一个 10MB，拆 key 不省空间；迁移链（`CONFIG_VERSION`）也按工具 key 组织。
- **被否决**: 独立 key（导出/同步漏数据、无原子性、迁移面更大）。

### D2. 引用 + 镜像：环境记 `strategyId`，未修改即镜像库条目

- **决策**: `DomainConfig` 新增 `strategyId?: string`，指向库条目。**绑定的默认形态是镜像**——环境**不**落 `strategyConfig.spec`，执行时 `readSpecFromConfig` 实时读库条目，库一改即对所有镜像环境生效。只有当用户在环境里改过声明并保存，`strategyConfig.spec` 才落盘为**私有声明**，覆盖库条目（脱镜）。
- **理由**: 初版（引用 + 快照）每绑定一个环境都复制一份声明：N 个环境 × 一份声明是 N 倍冗余，且「升级一次全部生效」必须靠用户逐次点同步。镜像让「共享策略的单一数据源」真正成立——这是策略库作为一等对象的核心价值。
- **取舍**: 镜像环境手里没有拷贝，库条目被删即回到「未配置登录」。这是可接受的：策略库与全量备份/WebDAV 同步同住一个 key，删除前 UI 已明确提示「N 个镜像环境将失去登录声明」。

### D3. 取消关联 / 删除策略都不产生环境记录

- **决策**:
  - **解除关联**：只删 `strategyId`；脱镜环境的私有声明原样保留（行为不变），镜像环境无声明可留、回到「未配置」。
  - **删除库条目**：从库里移除 + 摘掉所有绑定。不做任何物化拷贝——镜像环境失去声明，脱镜环境保留私有声明。环境数量前后不变。
  - **导入**：默认**仅存入策略库**，不产生任何环境；用户显式勾选「同时创建环境」才落地环境，且落地环境只写 `strategyId`（镜像形态）。
- **理由**: 这是本 ADR 要解决的核心症状。策略与环境的生命周期解耦后，「导入一份策略」与「新增一个环境」是两个独立动作。
- **零半成品**: 导入时策略库与环境在同一个 patch 里一次 `updateConfig` 落盘。

### D4. 同步 = 把脱镜环境重置回镜像

- **决策**: 策略库卡片提供「重置镜像」，把 `strategyId` 指向该条目且仍持有私有声明的环境**清掉 `strategyConfig.spec`**，回到镜像态。已是镜像 / 未绑定的环境不受影响。
- **理由**: 镜像语义下，库更新天然推给所有镜像环境，不再需要「推送内容」；唯一需要显式动作的是把「用户曾经在本环境改过、现在想放弃修改」的脱镜环境拉回来。
- **实现**: `syncBoundEnvironments` 返回新 `domains` 与更新数量；已是镜像的环境不重写。

### D5. 环境级变量覆盖走 `DomainConfig.vars`，导入不再把值烘进声明

- **决策**: 新增 `DomainConfig.vars?: Record<string, string>`。`buildSpecInputs` 的取值优先级变为 **环境覆盖 > `spec.vars[].default`**。配置包导入时，`requiredVars` 的填值写入落地环境的 `vars`，而非改写 `spec.vars[].default`。
- **理由**: 旧实现在 `confirmImport` 里把用户填的值写进 `spec.vars[].default`。策略可复用后，同一份声明绑到两个环境会互相污染。ADR-0015 D10 的迁移表早已预留「域值存 `DomainConfig.vars`」，此处接线。
- **边界**: 只有非 `secret` 变量可做环境覆盖；`secret: true` 仍只存在于声明本身且不得进配置包（ADR-0015 D9 不变）。
- **空值语义**: 覆盖值为空串视为「未覆盖」，回落到声明默认值。

### D6. 预设读取链：库优先，存量环境内联声明只读兼容

- **决策**: `collectStrategyPresets(domains, strategies?)` 先收录库条目（key 直接用库 id，形如 `custom:shared-login`），再收录**未绑定**环境的内联声明（旧数据，key 仍为 `custom:<slug>`）。不强制迁移。
- **理由**: 与「存量数据不自动改写」的口径一致。用户通过环境表单的「存入策略库」或设置页的「导入登录策略包」显式入库。
- **登录方式下拉**: 选中库条目 → 保存时写 `strategyId`，不落私有声明；选中其它预设（generic / 存量内联声明）→ 只套用声明，不建立绑定。

---

## 后果

### 正面

- 「导入策略」与「新增环境」成为两个独立动作，导入不再污染环境列表。
- 策略可删除、可编辑、可解绑，且任一动作都不会牵连环境记录的增减。
- **库是单一数据源**：编辑一次，所有镜像环境即时生效，不再需要逐个点同步。
- 环境配置体积减小：N 个环境共享同一策略只占一份声明的存储。
- 库与同步/备份天然同源，无需新增存储管线。

### 负面 / 风险

- **镜像环境依赖库条目**：库条目被删除即回到「未配置登录」。UI 在删除前明确提示影响面；跨设备同步丢失 `strategies` 字段时同理。
- **脱镜与镜像两种状态并存**：环境里改过一次声明即脱镜，后续库编辑不再影响它。UI 在表单上明确标出「已偏离库版本」，并提供「重置镜像」入口。
- **`strategyId` 悬空**: 外部导入/同步可能带来指向不存在条目的 id。读取侧（`listStrategyPresets` / 环境表单）按「未绑定」处理，保存时 `buildDomainEntry` 不写入悬空 id。
- **存量环境仍靠内联声明**: 未主动「存入策略库」的老环境不会出现在策略库里；这是有意的零迁移取舍，不是遗漏。

## 相关

- 纯函数模块与不变量：`entrypoints/tools/account-switch/spec/strategy-library.ts`（含 `isMirroring` 判定）
- 镜像回落：`entrypoints/tools/account-switch/spec/migrate.ts` `readSpecFromConfig(domainConfig, strategies)`
- UI：`config/StrategyLibrary.vue`（设置页策略卡：编辑 / 重置镜像 / 删除）、`config/DomainsPanel.vue`（环境表单的关联 / 解绑 / 存入 / 变量覆盖、导入向导的落地目标）
- 测试：`tests/strategy-library.test.ts`（含「绑定不拷声明」「镜像环境删除库后未配置」「脱镜环境重置回镜像」的回归）、`tests/login-spec-migrate.test.ts`（镜像回落）
- 术语：`docs/glossary.md`「登录策略库」「环境级变量覆盖」

## 后续修订（2026-10-26）：识别锁定只脱镜当前环境

- 新建保存的识别回写和手动锁定都只在当前环境形成私有 `strategyConfig.spec`，保留 `strategyId`；绝不更新 `strategies[id]` 或其它镜像。
- 后台先重读并只读重扫，存储锁内再次检查环境与期望自动 spec 未变化后才写最小 domains patch。迟到结果、删除、改 URL 和并发编辑均跳过。
- UI 明确提示脱镜影响；「重置镜像」仍沿用 D4 恢复共享声明。
