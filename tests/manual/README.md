# 自动登录本地手工验收

只用本目录的虚构页面与凭据 `demo / test-only-password`，不使用真实或内部系统。

```bash
python3 -m http.server 8765 --directory tests/manual
# 打开 http://localhost:8765/auto-login-fixture.html?mode=standard
```

## 验收记录

- [ ] 未打开目标页时保存 URL + 账号，再登录：自动填充并成功。
- [ ] 已打开标准表单时保存：显示已锁定；后续日志为 locked。
- [ ] `?mode=reload`：无密码框后仅刷新一次，出现表单并继续。
- [ ] `?mode=nopassword`：正常保存；最终定位失败，提供重试和手动定位，不循环刷新。
- [ ] `?mode=incomplete` / `?mode=multiple` / `?mode=iframe`：不完整和多表单不猜；iframe 三项来自同一 frame。
- [ ] 先锁定标准页，再改到 `?mode=locked`：具体定位失效且不改绑；恢复自动后可重试。
- [ ] 多步自定义 spec、策略库与另一镜像：执行和共享关系不回退。
- [ ] 无权限页、验证码、错误凭据、成功条件未满足：分类正确，日志无密码/Cookie/token。

**当前结果：未执行浏览器手工验收。** 自动化测试不能替代上述路径；交付时必须保留此状态，直至在真实扩展中逐项勾选。
