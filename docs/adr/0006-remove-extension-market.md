# ADR-0006: 移除插件市场（扩展引擎）

## 状态

已接受（2026-08-17）

## 背景

DevTools 在 v1.1.0 引入了插件市场（Extension Engine），允许用户从 Git 仓库安装第三方登录策略扩展。该功能包括：

- 扩展引擎（ext-engine/）：Git 加载器、本地加载器、运行时沙箱、存储管理、更新检查
- 扩展策略适配器（ExtensionStrategy）：将扩展适配为 LoginStrategy 接口
- 官方插件系统：templates/ 目录存放内置登录扩展示例
- 市场 UI：安装、卸载、更新、设置界面
- 消息协议：INSTALL_EXTENSION、UNINSTALL_EXTENSION 等 7 个消息类型
- 扩展存储：devtools-ext-* 命名空间

## 决策

**移除插件市场功能**，保留开发者模式（dev-mode）。

### 移除内容

| 层 | 内容 |
|---|---|
| 市场 UI | Config/ExtensionMarket.vue、ExtensionInstallDialog.vue、ExtensionDetail.vue、ExtensionSettingsForm.vue |
| 扩展引擎 | ext-engine/ 整目录（git-loader、local-loader、builtin-loader、manifest、runtime、storage、update-checker、extension-service） |
| 策略桥接 | strategies/extension-adapter.ts（ExtensionStrategy） |
| 官方插件 | templates/ 整目录 |
| 消息协议 | 7 条 EXTENSION_* 消息 |
| 存储/工具 | utils/script-storage.ts、utils/script-utils.ts、extLog 日志器 |
| 生命周期 | background.ts 的 initializeBuiltinExtensions / restoreStrategies |

### 保留内容

- 内置 API 登录与 `generic` 策略
- 开发者模式（继续服务 options「Dev 日志」）
- DomainsPanel 策略下拉（只剩内置策略）
- scaffolds/strategy（内置策略脚手架）

### 存量数据处理

启动时一次性迁移：
1. 删除扩展存储 key（devtools-ext-*、extension-src、注册表）
2. 域名 loginMethod 指向官方内置扩展 id → 重写为旧内置 API 登录标识
3. 第三方扩展 id 保留（登录时报「策略未找到」，引导手动修改）

## 原因

1. **功能未被使用**：插件市场是实验性功能，实际用户从未安装过第三方扩展
2. **维护成本高**：扩展引擎涉及沙箱安全、存储隔离、更新检查等复杂问题
3. **内置策略已够用**：内置 API 登录与 generic 策略覆盖当时的登录场景
4. **简化代码库**：移除后减少约 2000 行代码，降低维护负担

## 后果

### 正面

- 代码库简化，减少约 2000 行
- 消除扩展沙箱安全风险
- 降低存储管理复杂度
- 更快的构建和更小的扩展包体积

### 负面

- 失去第三方扩展能力（但实际未使用）
- 已有扩展用户需手动改配置（迁移脚本自动处理官方扩展，第三方扩展需手动）

### 中性

- 开发者模式保留，仍可调试日志
- 内置策略脚手架保留，未来可快速添加新登录策略

## 迁移指南

### 用户

1. 升级到新版本后，自动清理扩展存储
2. 官方扩展自动迁移为旧内置 API 登录策略
3. 第三方扩展需手动在「环境管理」中改选内置登录方式

### 开发者

1. 移除所有 ext-engine/* 导入
2. 移除 strategies/extension-adapter 相关代码
3. 移除 EXTENSION_* 消息处理
4. 扩展策略类型（AuthType: "custom"）已移除

## 相关 ADR

- ADR-0005: 扩展登录垂直链路（已废弃）
- ADR-0004: 深度优化第二轮（部分决策涉及扩展，已不适用）

## 参考

- 实施 commit: 2026-08-17
- 移除前代码量: ~2000 行（ext-engine/ + 市场 UI + 扩展相关工具）
- 移除后代码量: 减少约 40%
