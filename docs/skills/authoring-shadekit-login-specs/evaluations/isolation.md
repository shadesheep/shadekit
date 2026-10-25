# 独立分发验收

Date: 2026-10-25

## 隔离环境

仅将 Skill 复制到仓库外且带空格的目录：

`<temp>/shadekit skill isolation.<id>/skill bundle`

所有命令从另一个工作目录 `other cwd` 执行。未使用仓库中的源码、fixture、脚本或 node_modules。

## 命令与结果

| 检查 | 实际结果 |
|---|---|
| `node <copy>/scripts/test.mjs` | 33/33 PASS，0 FAIL |
| `package.mjs --spec login-spec.json --name Example --url {origin} --out dt-login-config.json` | 生成完整 `dt-login-config/v1` |
| `validate.mjs --spec login-spec.json --package dt-login-config.json` | `SNAPSHOT_STATIC_VALIDATED`，退出码 0 |
| `simulate.mjs` + `api-success.json` | `PASS`，`success:true` |
| `simulate.mjs` + `api-business-rejected.json` | `PASS`，`success:false`，`CONFIG_INVALID`，空内存会话 |
| page spec 包构造与静态验证 | `SNAPSHOT_STATIC_VALIDATED` |
| `simulate.mjs` + `page-unsupported.json` | `NOT_SIMULATED`，退出码 2 |

## 自包含扫描

对复制后的 38 个文件递归检查：

- 14 个运行时/类型 import 均为 `node:` 或可解析的相对路径；无仓库绝对路径或外部包 import。
- 3 个 Markdown 相对链接均能在复制目录内解析。
- 20 个 JSON 文件全部可解析。

## 自审修复后的复验

- 新增危险 body 路径和 Storage `__proto__` 键测试；原型污染用例先失败后通过。
- 新增 SHA-256、RSA-PKCS1v15、RSA-OAEP 独立有效路径测试。
- 重新复制到 `<temp>/shadekit skill postreview.<id>/skill bundle`，35/35 PASS，0 FAIL。
- 修复后完整项目回归：80 个 Vitest 文件、1176 个测试及 18 个 Node 测试全部通过；`npm run check` 通过。

## 未验证边界

- 此验收不执行真实导入、真实表单、真实会话写入或真实登录，均保持 `NOT_RUN`。
- DOM/页面/failure 轮询不在数据平面模拟范围内。
- fresh-context 模型重复测试未由此隔离 CLI 验收替代；其限制另记录于 `baseline.md`。
