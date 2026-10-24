# ADR-0007: 选项页配置套件(Config Kit)— 组件化 + watch 自动保存

## 状态

已接受(2026-08-18)

## 背景

7 个工具的选项页 `Config.vue` 各自重复同一套裸表单模板:`radio-group`/`toggle-item` 横排原生控件、散装数字框、每页复制「onMounted 读配置 → 展开合并 → 每个控件 `@change="saveConfig"`」的装配代码。元素普查:24 处 config-group、21 处原生 radio、12 处原生 checkbox,mock-data 一页就有 41 个表单元素。共享层只有 `config-page-styles.scss`(纯 CSS class),解决不了模板重复,原生 radio/checkbox 也无法达到设计规范里 Toggle Switch / Tabs 的视觉规格。

## 决策

**新建 `entrypoints/shared/config/` 配置页套件(Config Kit),全部 Config.vue 迁移为声明式组装 Setting Item。**

### 组件清单

| 组件 | 替代 | 视觉规格 |
|---|---|---|
| `DtConfigHeader` | 裸 `h3.config-title` | 标题 + 自动保存状态反馈(常态「更改自动保存」灰字,成功闪「✓ 已保存」) |
| `DtConfigItem` | `config-group` 裸 div | 单行左右布局:左 label(13px/500)+ hint(12px 灰),右控件,项间发丝分割线;`layout="stack"` 变体承载整块内容(如颜色图例) |
| `DtSegmented` | 原生 radio 组 ×7 | 分段控件:灰底槽 + 激活项渐变(indigo→blue)+ 白字 + shadow,同工具页 seg-group;泛型保留字面量联合类型 |
| `DtToggle` | 原生 checkbox ×12 | 38×20 开关,激活渐变 + glow,暗色 `#475569` 底 |
| `DtNumberField` | 散装数字框 | 96px 输入框 + focus ring;边界钳制在 normalize 钩子,不在组件内 |
| `DtConfigActions` | reset-btn 等动作行 | 按钮行容器,复用 DtButton |

### 保存范式(Auto-save)

新增 `useToolConfig(toolId, defaults)` composable:

- 加载:`getConfig(toolId, defaults)` 顶层浅合并(保留页内不编辑的字段,如 mock-data 的 fields)
- 保存:内部 `watch(config, debounce → updateConfig(toolId, patch))` + `loaded` 守卫,页内零保存代码;边界钳制走 `normalize` 钩子
- 反馈:配置页标题旁常驻「更改自动保存」,保存成功短暂变「✓ 已保存」后淡回;失败照旧错误 toast;「清空字段列表」等破坏性操作仍 toast
- 显式 `save()` 仍导出,供按钮动作使用

### 迁移节奏(分批)

- **第一批**:mock-data(41 元素)+ json-diff(9)+ code-beautify(11)——纯 Setting Item 页面,梯度覆盖验证组件 API
- **第二批**:json-formatter(20)、image-base64(12),env-indicator(矩阵)、account-switch(列表编辑器)私货部分保持原样,仅标准项迁移

### 明确不做

- 第一版不做 `DtSelect` / `DtTextField` / `DtConfigSection`(分组标题),用到再补
- account-switch 的列表卡片、密码框、domain-list 是列表编辑器而非设置项,不进 Config Kit
- 工具主页面(如 mock-data App.vue 顶栏)不在本套件范围,属信息架构问题另立项

## 已否决的替代方案

- **纯 scss 升级(增强 config-page-styles.scss)**:解决不了 7 页模板重复;原生 radio 无法用 CSS 变成分段控件
- **schema 驱动表单(声明 JSON 数组自动渲染)**:与现状差距过大,且 resetFields 等逃生舱动作、异构保存逻辑难塞进 schema;显式组装 + composable 已消灭绝大部分模板噪音
- **逐控件显式 `@change="save()"`**:几十处重复保存代码保留,与工具主页面的 watch+防抖范式(App.vue)心智不统一
- **完全静默保存(对齐 chrome://settings)**:用户来自手动保存时代,无任何反馈会让人不确定是否生效

## 后果

### 正面

- 新工具写 Config 页 = 组装 Setting Item,零表单模板、零保存装配代码
- Toggle/segmented 视觉规格一次写对、处处生效,暗色模式收口在 5 个组件内
- `updateConfig` 增量合并消除「整存整取丢字段」隐患(mock-data 注释里手动防过)

### 负面 / 风险

- 迁移期两批之间,选项页存在新旧两种写法并存
- `DtSegmented` 选项过多(>5)时会挤,超量场景需回退 select(届时补 DtSelect)

## 相关

- CONTEXT.md:Config Kit / Setting Item / Auto-save 词条
- 设计规范:CLAUDE.md「UI 设计风格」Toggle Switch、Tabs 规格
- 保存底座:`shared/tool-config.ts` 的 `updateConfig`(增量合并 + 跨上下文写锁)
