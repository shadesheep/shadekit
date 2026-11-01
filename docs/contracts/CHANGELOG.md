# 登录数据契约变更记录

本记录只收录共享数据契约的变更，不收录扩展或 Desktop 的 UI、策略模板、trace 格式、内部错误对象或执行器修复。

## v2 — 2026-11-01

- 建立 `LoginSpec.version = 2` 的人类可读基线。
- 固定 17 个算子：`clear.cookies`、`clear.storage`、`goto`、`http.execute`、`digest`、`crypto.encrypt`、`payload.build`、`map`、`apply.set`、`auth.write`、`auth.capture`、`auth.restore`、`fill`、`click`、`waitFor`、`extract`、`script`。
- 固定摘要能力 `sha1` / `sha256`，加密能力 `rsa-pkcs1v15` / `rsa-oaep`（OAEP 使用 SHA-256）。
- 发布每个算子的合法公开示例，以及未知算子/算法、R1–R7 和会话写入声明的非法示例。
- 明确三种独立版本：LoginSpec 声明版本、完整备份 `__version`、策略包 `dt-login-config/v1`。
- 延续 `shadekit-config-*.json` 明文完整备份和 `dt-login-config/v1` 策略分享包；不引入新备份格式。
- 明确策略包 `script` / 秘密变量为包级非法；可保留但不支持的声明按环境禁用并无损保留。

后续新增算子、摘要/加密算法或不兼容字段/语义修改时，必须共同约定新的 LoginSpec 版本并记录迁移与能力检查规则。模板内容、名称、UI 或内部实现变化不在此记录中冒充声明版本升级。
