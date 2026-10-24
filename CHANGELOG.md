# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.4] - 2026-10-21

### 新增

- 通用登录配方引擎：声明式登录声明（LoginSpec）、配方 → LoginSpec 迁移链、配方编辑器三层视图（ADR-0012 ~ 0015）
- 加密签名算子族（digest/crypto/payload/map）、`http.execute` 与 `apply.set` 算子
- 跨 origin 认证快照捕获/恢复（`auth.capture` / `auth.restore`）
- 试登录：默认零副作用
- 配置包导入导出：逐算子拒绝 script、secret 变量、requiredVars 双向校验
- 通用登录拾取器 UX 优化（ADR-0013），默认登录方式改为通用登录

### 修复

- 通用登录三处线上回归，编辑器 emit 防死循环
- 清理本域 cookie 时枚举全部路径

### 移除

- 禅道桥接组件（开源准备）

## [1.1.2] - 2026-09-07

### 新增

- Chrome / Edge 双商店一键发布脚本（`npm run release`）

### 性能

- Shadow DOM 样式管线迁移至官方机制，压缩器 terser → oxc，打包提速

## [1.1.1] - 2026-08-19

### 新增

- mock-data 工具：中文测试数据批量生成（人员/企业/招投标），JSON/CSV/SQL 导出
- 环境指示器徽标位置可配置（四角定位，默认右下角）
- 选项页 Config Kit 落地（ADR-0007）：声明式配置表单 + 自动保存

### 变更

- 移除插件市场系统，登录回归内置策略（ADR-0006）
- 降低宿主页侵入：Toast 惰性挂载、后台标签页暂停 SPA 路由轮询

## [1.0.1] - 2026-05-07

### 新增

- GitHub Actions CI、Vitest 单元测试、Biome 检查/格式化

### 安全

- 收紧 `host_permissions`，删除默认配置中的硬编码密码，移除签名密钥文件

### 修复

- 域名通配符匹配逻辑；sql-formatter 替换正则 SQL 美化器

## [1.0.0] - 2026-04-23

首个发布版本：账号切换、环境指示器、JSON 格式化、JSON 对比、图片 Base64、代码美化。
