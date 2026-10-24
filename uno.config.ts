import lucideIcons from '@iconify-json/lucide/icons.json' with { type: 'json' };
import { defineConfig, presetIcons, presetUno } from 'unocss';

export default defineConfig({
  // UnoCSS 默认不扫描纯 .ts 文件，但 content script 的 EnvIndicator、
  // toast 等在 .ts 中直接拼 UnoCSS 工具类，
  // 必须扩展扫描范围，否则 content.css 缺失这些样式（Shadow DOM 内样式丢失）
  content: {
    pipeline: {
      include: [/\.(vue|svelte|[jt]sx?|mdx?|astro|elm|php|phtml|html)($|\?)/],
    },
  },
  // tool-definitions.ts 中的图标类名在 options 页构建的模块图之外（运行时
  // 经 chrome.storage 传递），扫描覆盖不到，必须在 safelist 显式声明
  safelist: [
    'i-lucide-user-cog',
    'i-lucide-globe',
    'i-lucide-braces',
    'i-lucide-git-compare',
    'i-lucide-image',
    'i-lucide-code',
    // mock-data：tool-definitions.ts 的工具图标 + generators.ts 分类图标（同为纯 .ts 动态绑定）
    'i-lucide-dices',
    'i-lucide-sliders-horizontal',
    'i-lucide-user',
    'i-lucide-building-2',
    'i-lucide-gavel',
    'i-lucide-cpu',
  ],
  presets: [
    presetUno({
      dark: { dark: '[data-dt-dark]' },
    }),
    presetIcons({
      collections: {
        lucide: lucideIcons as any,
      },
      mode: 'auto',
      scale: 1.2,
      extraProperties: {
        display: 'inline-block',
      },
    }),
  ],
  shortcuts: {
    // Shadows
    'dt-shadow-card':
      'shadow-[0_1px_3px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_3px_rgba(0,0,0,0.3),0_1px_2px_rgba(0,0,0,0.2)]',
    'dt-shadow-hover':
      'shadow-[0_4px_12px_rgba(0,0,0,0.08),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_4px_12px_rgba(0,0,0,0.4),0_2px_4px_rgba(0,0,0,0.3)]',
    'dt-shadow-panel':
      'shadow-[0_8px_24px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.06)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.5),0_2px_8px_rgba(0,0,0,0.4)]',

    // Gradients
    'dt-gradient-primary': 'bg-gradient-to-r from-indigo-500 to-blue-500',
    'dt-gradient-primary-text':
      'bg-gradient-to-r from-indigo-500 to-blue-500 bg-clip-text text-transparent',
    'dt-gradient-env':
      'bg-gradient-to-r from-indigo-50 to-blue-50 dark:from-indigo-900/20 dark:to-blue-900/20',
    'dt-gradient-header':
      'bg-gradient-to-r from-indigo-500 via-blue-500 to-cyan-400',

    // Glass effect
    'dt-glass': 'backdrop-blur-sm bg-white/80 dark:bg-slate-800/80',

    // Card base
    'dt-card-base':
      'bg-white dark:bg-slate-800 rounded-[10px] shadow-card border border-slate-200 dark:border-slate-700 transition-all duration-200 ease-out',

    // Buttons
    'dt-btn-primary':
      'px-3 py-1.5 bg-gradient-to-r from-indigo-500 to-blue-500 text-white rounded-md hover:from-indigo-600 hover:to-blue-600 cursor-pointer text-sm transition-all duration-200 active:scale-[0.98]',
    'dt-btn-danger':
      'px-3 py-1.5 bg-red-50 text-red-600 rounded-md hover:bg-red-100 cursor-pointer text-sm transition-all duration-200 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/30',
    'dt-btn-secondary':
      'px-3 py-1.5 bg-slate-100 text-slate-700 rounded-md hover:bg-slate-200 cursor-pointer text-sm transition-all duration-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600',
    'dt-btn-icon':
      'border-none bg-transparent cursor-pointer rounded-md text-slate-500 dark:text-slate-400 p-1 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors duration-150',

    // Input
    'dt-input-base':
      'w-full box-border px-3 py-2 border border-slate-200 dark:border-slate-700 rounded-md text-sm focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/10 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 transition-colors duration-150',

    // Text utilities
    'dt-text-body': 'text-[13px] text-slate-900 dark:text-slate-100',
    'dt-text-small': 'text-[12px] text-slate-500 dark:text-slate-400',
    'dt-text-micro': 'text-[11px] text-slate-400 dark:text-slate-500 font-medium',

    // Toggle switch (used in ToolMarket)
    'dt-toggle-track':
      'relative inline-block w-[38px] h-5 rounded-full bg-slate-200 dark:bg-slate-600 transition-colors duration-200 ease-in-out',
    'dt-toggle-thumb':
      'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out',
  },
});
