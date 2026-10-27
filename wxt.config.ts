import { resolve } from "node:path";
import Vue from "@vitejs/plugin-vue";
import UnoCSS from "unocss/vite";
import { defineConfig } from "wxt";

export default defineConfig({
  // WXT 0.20+: runner 配置更名为 webExt
  webExt: {
    disabled: true, // 不自动拉起浏览器，手动加载
  },
  // 源码包会公开上传到 AMO，必须剔除本地密钥与 Git 已忽略的原始录像
  zip: {
    excludeSources: ["keys/**", "docs/images/raw/**"],
  },
  manifest: ({ browser }) => ({
    name: "ShadeKit",
    description: "开发者工具集合：账号切换、JSON 格式化、代码美化、模拟数据、环境指示等",
    homepage_url: "https://github.com/shadesheep/shadekit",
    icons: {
      16: "logo_16.png",
      48: "logo_48.png",
      128: "logo_128.png",
    },
    web_accessible_resources: [
      {
        resources: ["logo_48.png", "logo_128.png"],
        matches: ["http://*/*", "https://*/*"],
      },
    ],
    permissions: [
      "storage",
      "cookies",
      "activeTab",
      "tabs",
      "scripting",
      "contextMenus",
      "notifications",
    ],
    host_permissions: ["http://*/*", "https://*/*"],
    commands: {
      "open-account-switcher": {
        suggested_key: {
          default: "Alt+Shift+A",
        },
        description: "快速切换账号",
      },
    },
    // Firefox 专属：AMO 要求固定 ID，且新扩展必须声明数据收集策略
    ...(browser === "firefox" && {
      browser_specific_settings: {
        gecko: {
          id: "shadekit@shadesheep.github.io",
          data_collection_permissions: { required: ["none"] },
        },
      },
    }),
  }),
  hooks: {
    'vite:build:extendConfig': (_entrypoints, viteConfig) => {
      // WXT uses lib mode (IIFE format) for background scripts,
      // which forces inlineDynamicImports=true. Rollup doesn't allow
      // manualChunks together with inlineDynamicImports, so we remove
      // manualChunks for those builds to avoid a build error.
      const build = viteConfig.build as {
        lib?: unknown;
        rollupOptions?: { output?: Record<string, unknown> };
        rolldownOptions?: { output?: Record<string, unknown> };
      } | undefined;
      if (build?.lib) {
        for (const key of ['rollupOptions', 'rolldownOptions'] as const) {
          const output = build[key]?.output;
          if (output && typeof output === 'object' && 'manualChunks' in output) {
            delete output.manualChunks;
          }
        }
      }
    },
  },
  vite: () => ({
    // Vite 8: WXT 分析入口时使用名为 "inline" 的非 client 环境，
    // vite:css 插件的 buildStart 默认不在该环境执行，
    // 导致 SCSS transform 时 preprocessorWorkerController 未初始化
    // （"Cannot read properties of undefined (reading 'scss')"）。
    // 开启后所有插件的 buildStart 在每个环境都会执行。
    server: {
      perEnvironmentStartEndDuringDev: true,
    },
    resolve: {
      alias: {
        "~shared": resolve(__dirname, "entrypoints/shared"),
      },
    },
    build: {
      // Vite 8: rollupOptions 是 rolldownOptions 的废弃别名
      rolldownOptions: {
        output: {
          // Vite 8 (Rolldown) 不再支持 manualChunks 对象语法，改用函数形式
          manualChunks(id: string) {
            // Separate CodeMirror into its own chunk
            if (id.includes("@codemirror/") || id.includes("node_modules/codemirror/")) {
              return "codemirror";
            }
            // Vendor libraries chunk
            if (
              id.includes("node_modules/jsencrypt/") ||
              id.includes("node_modules/fast-json-patch/") ||
              id.includes("node_modules/json-source-map/")
            ) {
              return "vendor";
            }
          },
          // oxc 压缩选项（drop console/debugger，替代原 terser 配置）
          minify: {
            compress: {
              dropConsole: true,
              dropDebugger: true,
            },
          },
        },
      },
      // Vite 8 默认压缩器（Rolldown 内置 oxc），比 terser 快一个数量级
      minify: "oxc",
    },
    plugins: [
      Vue(),
      UnoCSS(),
      // Chrome MV3 扩展页面修复：
      // 1. 移除 Vite 自动添加的 crossorigin 属性（CORS 不被扩展支持）
      // 2. 移除 <link rel="modulepreload"> 标签
      //    Chrome 的 preload 扫描器会把相对路径解析为 extensions://<id>/...，
      //    但 ES module 加载器的规范 URL 是 chrome-extension://<id>/...，
      //    两者在 Chrome 内部被视为不同的 "world"，触发
      //    "cross-world extension resource mismatch" 警告。
      //    移除 preload 链接不影响功能：JS 内的 import 走模块加载器，仍会按需加载。
      {
        name: "chrome-extension-html-fix",
        enforce: "post" as const,
        transformIndexHtml(html: string) {
          let result = html;
          // 移除所有 crossorigin 属性（包括 crossorigin="" 和 crossorigin="anonymous"）
          result = result.replace(/\s+crossorigin(?:="[^"]*")?/g, "");
          // 移除所有 <link rel="modulepreload" ...> 标签
          result = result.replace(/\s*<link[^>]*rel\s*=\s*["']?modulepreload["']?[^>]*>/gi, "");
          return result;
        },
      },
    ],
  }),
});
