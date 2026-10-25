# dt-login-config/v1 策略包

## 结构

```ts
interface ConfigPackage {
  format: "dt-login-config/v1";
  specVersion: 2;
  requiredVars: Array<{ name: string; title?: string }>;
  environments: Array<{
    name: string;
    url: string;
    loginMethod?: string;
    spec: LoginSpec;
    requiredVars: Array<{ name: string; title?: string }>;
  }>;
}
```

- 包级与环境级 requiredVars 必须同步，且都是对应 `spec.vars` 的子集。
- 默认 requiredVars 是无 default 且非 secret 的 vars；显式列表会去重。
- 每个 `environments[].spec` 必须与独立交付 LoginSpec 深度相等；对象 key 顺序不影响相等。
- 包不包含账号绑定、明文密码、真实 token、secret 变量或 script 算子。
- `specVersion` 高于接收方支持版本会被拒绝；包格式校验不能替代内层 LoginSpec 校验。
- 地址未知时使用字面量 `{origin}`，由导入 UI 收集真实地址。

## 构造

```bash
node <skill>/scripts/package.mjs \
  --spec login-spec.json \
  --name "Example" \
  --url "{origin}" \
  --out dt-login-config.json
```

可选参数：`--login-method <id>`、`--required-vars tenant,realm`；传空字符串表示无必填变量。只有 `--out` 指定的文件会被写入。

## 验证

```bash
node <skill>/scripts/validate.mjs --spec login-spec.json --package dt-login-config.json
```

输出状态：

- `SNAPSHOT_STATIC_VALIDATED`，退出码 0：内层 spec、包、深度相等和会话门控全部通过。
- `FAILED`，退出码 1：查看 `specIssues`、`packageIssues`、`equalityIssues`、`gateIssues` 的 path/opIndex 并修复。

有 ShadeKit 仓库时再使用 `repo-verify.ts` 调用官方 `validateLoginSpec`、`buildConfigPackage`、`validateConfigPackage`。官方包验证通过仍不能省略内层 spec 验证。
