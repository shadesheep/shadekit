# 浏览器插件商店素材

本目录是从真实扩展界面生成的 Chrome Web Store / Microsoft Edge Add-ons 上架素材。脚本只做裁切、缩放、边框和文字说明，不重绘扩展界面；原始截图由 [`docs/readme-demo/capture.mjs`](../readme-demo/capture.mjs) 驱动真实扩展采集。

## 商店要求对照

| 素材 | Chrome Web Store | Microsoft Edge Add-ons | 本目录文件 |
|---|---|---|---|
| 商店图标 | 128×128 PNG | 300×300（最小 128×128） | `icons/icon-128.png`、`icons/icon-300.png` |
| 截图 | 至少 1 张，**最多 5 张**，1280×800 或 640×400 | 最多 6 张，1280×800 或 640×480 | `screenshots/01`–`06`（均为 1280×800） |
| 小促销图块 | 440×280，**必填** | 440×280，可选 | `promo/small-promo-440x280.png` |
| 大促销图 / Marquee | 1400×560，可选（不提供则不会进入首页推荐位） | 1400×560，可选 | `promo/marquee-1400x560.png` |

> Chrome 最多 5 张截图：上传 `01`–`05`。Edge 可上传全部 6 张（第 6 张是元素拾取）。
> 促销图块不可本地化，因此同时提供无文字版本（`*-textless.png`）：多语言上架时优先用它，避免中文被固定进图片。

## 现有 `docs/images/` 为什么不能直接上传

`docs/images/` 是 README 配图，格式、尺寸和构图都不符合商店要求：

| 文件 | 问题 |
|---|---|
| `hero.webp`、`login-recipe.webp`、`dev-tools.webp` | WebP 格式；1440px 宽（非 1280×800）；带 README 专用标题排版 |
| `local-account-storage.webp`、`multi-env-accounts.webp`、`unified-switcher-panel.webp` | 手绘示意图，不是产品界面；1600×900 |
| `account-switch.gif` | GIF 不是商店支持的截图格式 |

其中手绘示意图表达的是产品概念，不适合作为商店截图；如需用作促销图，必须按 440×280 / 1400×560 重新排版。

## 重新生成

原始截图默认读取 `docs/images/raw/`（Git 忽略）。先按 [`docs/readme-demo/README.md`](../readme-demo/README.md) 启动演示服务并用 `capture.mjs` 采集，然后：

```bash
python3 docs/store/compose-store.py
# 原始截图在别处时：
SHADEKIT_STORE_RAW=/tmp/shadekit-store-raw python3 docs/store/compose-store.py
# 只校验尺寸、格式与体积：
python3 docs/store/compose-store.py --validate
```

依赖 Python 3 + Pillow，以及支持中文的 PingFang / Arial Unicode 字体。

## 上架前还缺的材料（非图片）

- **商店描述**：Chrome 132 字符以内的简短描述 + 详细描述；Edge 250–10000 字符。
- **隐私政策 URL**：账号密码与登录会话属于敏感数据处理信息，两个商店都要求提供可公开访问的隐私政策页面。仓库内只有 README 的「本地数据与隐私」章节，需要单独发布为网页。
- **权限说明**：Chrome 审核会逐项核对 `host_permissions` / `content_scripts` 的用途，需准备「为什么需要注入所有站点」的说明（环境指示器、账号切换面板）。
- **单一用途说明**（Chrome）：说明扩展的单一用途是「开发者/测试的浏览器工具箱」。
- **审核测试说明**：如何在不接触真实系统的情况下验证账号切换（可用仓库内的本地演示站）。
