# ADR-0016: WebDAV 配置同步（草案）

- **日期**: 2026-10-22
- **状态**: 已接受（评审修订：白名单载荷、verifier 独立 IV；二次修订：冲突检测由 ETag CAS 改为 LOCK 串行化——x/net/webdav handlePut 不支持条件请求）
- **背景**: ShadeKit 全部配置存于 `chrome.storage.local`（key 前缀 `devtools-`），含 account-switch 的明文账号密码（`Account.password`、`DomainConfig.defaultPassword`、`strategyParams.clientSecret` 等），以及 LoginSpec 登录声明（可含 `script` 算子与 `secret: true` 变量——配置包刻意排除这两类，同步载荷则刻意全含，因为同步场景是自有设备整包迁移）。多设备间迁移目前只能靠选项页手动导出/导入 JSON 文件。目标：通过用户自部署的 WebDAV 服务实现配置（含密码）的多设备同步。
- **范围**: 新增 `entrypoints/tools/webdav-sync/`；改动 `entrypoints/shared/tool-definitions.ts`（注册）。不涉及既有工具内部逻辑。服务端由用户自行部署，不在本仓库范围，仅记录接口约定。
- **关联**: ADR-0003 D5（读取侧默认值）、ADR-0006（工具市场移除后的注册机制）；复用 `tool-config.ts` 的 `getAllConfig` / `setAllConfig` / `migrateConfig` / `CONFIG_VERSION` 管线。

---

## 备选方案评审

### S1. chrome.storage.sync（浏览器自带同步）——否决

| 限制 | 影响 |
|---|---|
| 单项 8KB / 总量 100KB | account-switch 单 key 含全部账号 + 环境（含 RSA 公钥），易超 8KB；需拆 key + 压缩，复杂度不亚于自研 |
| 数据上传至 Google/Microsoft 账户体系，加密强度取决于用户账户全局设置，扩展不可控 | 违背「服务器无法解密」的设计原则 |
| Chrome Sync 国内不可达；Edge Sync 依赖登录 Microsoft 账户 | 目标用户使用场景下不可靠 |
| 无版本/mtime 概念，分叉静默覆盖，扩展无法感知冲突 | 多设备使用有丢数据风险 |
| Chrome 与 Edge 各同步各的，互不通 | 跨浏览器场景失效 |

### S2. 自建后端 API ——否决

为几十 KB 的同步载荷引入用户体系与数据库，运维成本与收益不匹配。

### S3. WebDAV（采纳）

服务端可采用兼容 WebDAV LOCK/UNLOCK 的自托管实现（例如 `hacdias/webdav`），由用户配置 HTTPS 与独立访问凭据：`https://dav.example.com/`（保留示例域名，非部署地址）。需要完整 WebDAV 方法集、Basic 认证以及不改写加密文件 Content-Type 的行为；威胁模型为「只存加密文件，服务器无法解密」。扩展端 `host_permissions: *://*/*` 已覆盖，跨域 fetch 无 CORS 约束，无需新增 manifest 权限（P1 定时同步才需 `alarms`）。

---

## 决策

### D1. 同步载荷与文件布局

- 载荷由**注册表白名单**构造（非「前缀全收」）：遍历 `tool-definitions.ts` 的 `allTools` 逐 id 读 `keyFor(id)`，显式附加 `state`（工具开关）与 `theme`（主题）两个共享 key，附 `__version`。
- **默认排除、显式放行**。以下 key 永不进入载荷：
  - `devtools-logs`——统一日志存储（`shared/logger.ts`），dev 模式含完整请求/响应轨迹（`xstr` 密文按 ADR-0015 D8 刻意 reveal），同步会互相覆盖本地排障痕迹；
  - `devtools-webdav-sync` 及其备份——同步工具自身配置（含冲突检测状态）与本地备份，见 D4；
  - `devtools-migrated`——迁移标记。
  - 白名单方向保证未来新增任何非配置 key（缓存/锁/计数器）自动免疫，不靠排除列表堵漏。
- 加密后单文件上传。远端路径：固定 `/devtools/config.enc`（可在配置中改）。
- 单人多设备共用该文件；多人/多配置槽位（`/devtools/<slot>/`）留 P2。

### D2. 加密信封格式（Envelope）

单文件 JSON，自描述、可演进：

```json
{
  "v": 1,
  "kdf": { "algo": "PBKDF2-SHA256", "iterations": 210000, "salt": "<b64>" },
  "cipher": { "algo": "AES-256-GCM", "iv": "<b64>" },
  "verifier": { "iv": "<b64>", "ct": "<b64>" },
  "extVersion": "1.x.y",
  "payload": "<b64>"
}
```

- `payload` = AES-GCM(载荷序列化 JSON)；salt/iv 每次写入随机生成。
- `verifier` = 同一密钥、**独立随机 IV** 加密固定常量 `"devtools-sync-ok"` 的密文。GCM 严禁同密钥复用 IV，verifier 与 payload 必须各自携带 IV。下载后先解密 verifier 快速判定「口令错误」，避免 payload 解密失败时的歧义报错。
- `extVersion` 记录写入方扩展版本，仅作跨版本排障提示。LoginSpec 的版本门在运行时 `migrateSpec` 已存在（高版本声明明确拒绝，提示先升级扩展），恢复路径不重复校验。
- KDF 参数写入文件，未来可调；实现使用 WebCrypto，零依赖。
- 口令错误、缺 `v` 字段（如误传明文导出的 JSON）、解析失败一律拒绝导入，本地零变更。

### D3. 三类凭据职责分离

| 凭据 | 用途 | 存储 |
|---|---|---|
| WebDAV 密码 | HTTP Basic 认证 | `chrome.storage.local` 明文（自动同步的必要妥协，UI 明确提示使用独立密码） |
| 同步口令 passphrase | AES-GCM 密钥派生源 | **不落盘**，每次同步输入（P1 可选 session 内缓存） |
| 业务账号密码 | 被同步的数据 | 仅存于密文 payload 内 |

> passphrase 强度是整个威胁模型的承重墙：WebDAV 密码泄露 ≠ 配置泄露，前提是 passphrase 足够强且**与 WebDAV 密码不同**（载荷现含可执行 `script` 算子与全部明文密码，口令是唯一屏障）。UI 必须强制提示，不得静默带过。

### D4. 冲突检测与本地备份

- 本地记录 `lastRemoteEtag`（上次同步时远端 `getetag`）。
- 上传走**锁内预检**：`LOCK`（exclusive write，`Timeout: Second-300`）→ `PROPFIND` 取 `getetag` → 与 `lastRemoteEtag` 比较：不匹配、或无本地记录而远端已存在 → 释放锁并弹确认「强制上传将覆盖远端」，确认后 force 重放；一致 → `PUT` → 以 PUT 响应 ETag（缺失时回落 PROPFIND）更新 `lastRemoteEtag` → `finally` UNLOCK。依据：x/net/webdav `handlePut` 源码 TODO 明确不支持 `If-Match`/`If-None-Match`（条件请求被静默忽略、PUT 永远覆盖成功），CAS 不可用；hacdias/webdav v5.8.0 启用 `webdav.NewMemLS()`，锁在单服务端进程内跨设备互斥。LOCK 返回 423 →「另一台设备正在同步，请稍后重试」。
- 首次上传（远端不存在）：`MKCOL` 创建父集合后 `PUT`。
- 下载覆盖本地前，将当前全量配置快照至 `__devtools-webdav-backup__`（非 `devtools-` 前缀，仿 `__devtools-dock__`：不进载荷、不随同步扩散；含时间戳，仅留最近一份），提供回滚入口。
- P0 不做字段级合并。

### D5. 模块结构

```
entrypoints/tools/webdav-sync/
├── types.ts              # WebdavSyncConfig、Envelope、SyncState
├── webdav-client.ts      # 最小客户端：PROPFIND / GET / PUT / MKCOL / LOCK / UNLOCK，无第三方依赖
├── crypto.ts             # PBKDF2 + AES-GCM（WebCrypto）
├── sync-engine.ts        # upload() / download() / buildPayload()（白名单构造，见 D1）；恢复路径显式为 migrateConfig(payload) → setAllConfig（setAllConfig 内部不做迁移）；PUT 响应缺 ETag 时回落 PROPFIND
└── Config.vue            # 服务器配置 + 手动同步 + 状态展示
```

注册进 `tool-definitions.ts`，`configSection` 出现在选项页侧边栏。

配置存于 `devtools-webdav-sync` key，走现有 `tool-config.ts` 管线：

```ts
interface WebdavSyncConfig {
  url: string;             // 用户自己的 WebDAV HTTPS 地址
  username: string;        // 独立同步账号
  password: string;        // WebDAV 密码（明文，见 D3）
  remotePath: string;      // 默认 /devtools/config.enc
  lastRemoteEtag?: string;
  lastSyncAt?: number;
}
```

注意：本配置（含 `lastRemoteEtag`）被 D1 白名单天然排除在载荷外，下载恢复不会继承他设备的冲突检测状态。下载完成后须以本次 GET 响应的 ETag 重写 `lastRemoteEtag`；上传成功后同样须以 PUT 响应头的 ETag 刷新（否则本机下次上传会对自己的写入误报冲突）。

### D6. UI 分区（选项页「同步」）

1. **服务器**：URL / 用户名 / 密码 / 远程路径 + 「测试连接」（PROPFIND 探活，区分认证失败 / 网络错误 / 路径权限）。
2. **同步操作**：口令输入框（不存储；强制提示「口令强度是唯一屏障，且不得与 WebDAV 密码相同」，见 D3）+「上传到云端」「从云端恢复」+ 冲突确认对话框。
3. **状态**：最后同步时间、远端文件 ETag、备份回滚按钮。

### D7. 错误处理

| 场景 | 行为 |
|---|---|
| 口令错误 | verifier 解密失败 →「同步口令不正确」，不动本地数据 |
| 远端文件不存在（首次） | 下载提示「云端暂无配置」；上传先 MKCOL（405 忽略）再 PUT 创建 |
| etag 不匹配（锁内预检） | 远端已被他设备修改 → 弹「强制上传将覆盖远端」确认；确认后 force 重放 |
| 423（锁被占） | 「另一台设备正在同步，请稍后重试」 |
| 401/403 | 「WebDAV 凭据无效或目录无权限」 |
| 网络失败/超时 | fetch 超时 15s，toast 报错，本地零副作用 |
| 远端文件非本格式 | envelope 解析失败 → 拒绝导入 |
| 写入失败 | 复用 `safeStorageSet` 的错误 toast，不展示成功假反馈（沿袭 v1.3.0 issue 03 约定） |

### D8. 服务端约定（用户自托管）

- 创建独立同步账号与强随机密码，只授予同步目录的必要读写权限。
- 使用 HTTPS，限制账号不能访问其他用户的目录；不要把服务端管理密码写入本仓库。
- 部署与升级由用户按所选 WebDAV 服务的文档执行，本仓库不携带内部部署配置。

### D9. 里程碑

| 阶段 | 内容 | 预估 |
|---|---|---|
| **P0** | 服务端用户 + 扩展端手动上传/下载 + 加密 + 冲突检测 + 备份回滚 | 1.5~2 天 |
| P1 | 配置保存后防抖自动上传；启动时口令已缓存则自动拉取（按需加 `alarms` 权限） | 1 天 |
| P2 | 多配置槽位、同步历史 | 按需 |

### D10. P0 验收标准

1. A 机改配置 → 上传 → B 机下载，全量工具配置（含账号密码）一致。
2. 服务端 `webdav-data/devtools/config.enc` 为密文，检索不出任何明文密码。
3. 错误口令下载：明确报错，本地数据零变更。
4. 双机分叉上传：后上传方收到冲突提示（锁内预检 etag 不匹配）→ 出现覆盖确认；确认后可经备份回滚。
5. 独立同步账号访问其权限范围外的路径时返回 403。
6. 重复执行部署配置不会覆盖其他服务的凭据。
7. 解密载荷 JSON 中不含 `devtools-logs`、`webdav-sync`、备份 key（D1 白名单生效）。

---

## 明确排除项

- 字段级 / 账号级合并（v1 只做整包覆盖 + 用户选边）。
- 实时同步、版本历史。
- chrome.storage.sync 后端（S1 已否决；如未来需要「非敏感配置轻量同步」，另行立项，不在本文范围）。
