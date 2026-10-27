# 本机演示系统与 README 配图

这里提供可复现的虚构演示站、真实扩展截图驱动、排版脚本，以及 README 配图与备用示意图。不会连接任何内网或生产系统，不使用日常浏览器资料。

## 成品

| 文件 | 内容 | 来源 |
|---|---|---|
| `docs/images/hero.webp` | 账号面板与环境指示器 | 真实扩展 + 本机演示控制台 |
| `docs/images/account-switch.gif` | 验收测试 → 交付管理员 | 真实扩展操作的连续录像 |
| `docs/images/login-recipe.webp` | 添加环境、拾取元素、保存配置 | 真实配置抽屉和页面拾取 |
| `docs/images/dev-tools.webp` | JSON 格式化、对比、模拟数据 | 三个真实独立工具页 |
| `docs/images/local-account-storage.webp` | 本地存储示意 | 手绘示意图 |
| `docs/images/multi-env-accounts.webp` | 多环境、多账号切换痛点 | 手绘示意图 |
| `docs/images/unified-switcher-panel.webp` | 悬浮面板选择环境与账号 | 手绘示意图 |

所有截图中的账号、组织、项目、指标均为虚构。登录服务只监听 `127.0.0.1`；`.test` 域名通过临时 Chrome 的 resolver 映射到本机。演示 Cookie 为内存 HttpOnly 会话，服务重启即失效。

## 启动

```bash
npm run build
node docs/readme-demo/server.mjs
```

浏览器打开 `http://127.0.0.1:4173/login`。可选择林屿（交付管理员）或周然（验收测试）自动填入虚构凭据。

## 截图驱动

驱动使用 Playwright 和隔离的 Chrome profile；**不修改项目依赖**。驱动查找 `/tmp/shadekit-readme-tools` 中的 Playwright，也可用 `PLAYWRIGHT_MODULE` 指定已有的模块。

```bash
npm install --prefix /tmp/shadekit-readme-tools playwright@1.64.1
PLAYWRIGHT_BROWSERS_PATH=/tmp/shadekit-readme-browsers \
  /tmp/shadekit-readme-tools/node_modules/.bin/playwright install chromium

# 另一个终端保持演示服务运行
node docs/readme-demo/capture.mjs all
```

脚本执行真实的「新建环境 → 识别 → 回填 → 拾取 → 确认认证键 → 保存配置与账号」，打开 Shadow DOM 账号面板，并断言 `data-current-role` 从 `tester` 变为 `admin`；同时验证认证键被清除、无关本地存储保留。录像前通过本机演示 API 建立真实 HttpOnly 测试员会话，再创建录制标签页，因此 GIF 从测试员控制台开始，不包含准备阶段的登录表单或密码提示。无头浏览器不总是分发扩展快捷键，此时通过扩展自己的后台消息唤起面板，不渲染替代 UI。面板保持产品原始尺寸。

采集脚本从当前临时 Playwright 安装中解析配套 Chromium 路径，不依赖某个本机浏览器目录；`PLAYWRIGHT_BROWSERS_PATH` 需在安装和采集时保持一致。需要 MV3 扩展支持时应使用 Chrome for Testing，系统 Chrome 可能禁用侧载扩展。可用 `CHROME_PATH` 显式指定可执行文件。

分开执行（按顺序复用同一个隔离 profile；若改目录，需同步修改 `SHADEKIT_DEMO_PROFILE`）：

```bash
node docs/readme-demo/capture.mjs setup
node docs/readme-demo/capture.mjs hero
node docs/readme-demo/capture.mjs record
node docs/readme-demo/capture.mjs tools
```

可用环境变量：`SHADEKIT_DEMO_PROFILE`、`SHADEKIT_DEMO_RAW`、`SHADEKIT_DEMO_VIDEO`、`CHROME_PATH`。原始 PNG、WebM 和诊断文件保存在 `docs/images/raw/`（Git 忽略）或指定的 `/tmp` 目录，不作为公开素材直接引用。

## 排版与 GIF

需要 Python 3、Pillow、支持中文的 PingFang/Arial Unicode 字体和 FFmpeg。默认 FFmpeg 可在 `PATH` 中查找，或用 `FFMPEG_PATH` 指定。

```bash
python3 docs/readme-demo/compose.py --gif
# 已分开执行 record，且原始目录没有 hero/tool 截图时：
SHADEKIT_DEMO_RAW=/path/to/raw python3 docs/readme-demo/compose.py --gif-only
python3 docs/readme-demo/compose.py --validate
python3 docs/readme-demo/compose.test.py
```

当原始素材在 `/tmp` 时，补 `SHADEKIT_DEMO_RAW=/path/to/raw`；编码单独录制的标签页时补 `SHADEKIT_DEMO_SWITCH_VIDEO=/path/to/video.webm`。`all` 和 `record` 都会录像，并在开始时清除该原始目录中旧的验证清单；只有本次角色断言通过后才写入新的 `verified-switch-video.json`，排版脚本据此选择录像，显式路径也必须与该清单一致。清单只记录角色断言和本机临时路径，不含凭据。排版只做裁切、缩放、边框和文字说明，不重绘扩展界面，也不补造登录成功帧；配方图裁掉演示页的密码提示。GIF 为 1152px 宽、约 13 秒，脚本逐帧校验时长和体积。

## 验证

```bash
npm run check
npm test
npx vitest run tests/readme-demo-config.test.ts
npm run test:demo
python3 docs/readme-demo/compose.test.py
```

原生 Node 测试与 Vitest 分开执行，`npm test` 不会把 `server.test.mjs` 当作 Vitest suite。模拟数据截图使用「用户信息」模板，生成的是本地虚构测试数据。
