/**
 * 环境指示器 - 内容脚本
 * 在页面角落显示当前所属环境标签
 *
 * 宿主页面零侵入设计：
 * - badge 渲染在 Shadow Root 内，与宿主页面样式双向隔离
 * - 仅在匹配到环境时才向 body 注入 host 节点，不匹配时 DOM 零残留
 * - 紧凑半透明小 pill 始终显示环境名，hover 仅提亮，不遮挡页面浮层
 *
 * SPA 支持：监听路由变化，URL 变化后重新评估——
 * 新 URL 匹配环境规则时更新 badge，不再匹配时移除；
 * 监听只安装一次，不重复注入、不泄漏。
 */

import { getConfig } from '../../shared/tool-config';
import {
  ACCOUNT_SWITCH_CONFIG_DEFAULTS,
  type AccountSwitchConfig,
  type EnvBadgeConfig,
  type EnvBadgePosition,
} from './types';
import { matchDomain } from './utils/env';
import { watchSpaRoutes, type SpaRouteWatcher } from './utils/spa-route';
import { normalizeEnvTag, tagColor } from './account-env-view';

/** evaluateEnv 入参：账号切换配置中参与评估的部分 */
export interface EnvEvaluateConfig {
  domains?: Record<string, { name: string; tags: string[] }>;
  envBadge?: { whitelist?: string[] };
}

export interface EnvMatch {
  name: string;
  tags: string[];
}

const HOST_ID = 'shadekit-env-badge-host';

/** 各角落的 host 定位样式（偏移量避开页面边缘） */
const POSITION_STYLES: Record<EnvBadgePosition, string> = {
  'bottom-right': 'bottom: 16px; right: 16px;',
  'bottom-left': 'bottom: 16px; left: 16px;',
  'top-right': 'top: 16px; right: 16px;',
  'top-left': 'top: 16px; left: 16px;',
};

/**
 * 纯函数：根据合并后的配置与 origin 评估匹配环境。
 * envBadge.whitelist 非空时，origin 不在白名单中直接判不匹配。
 */
export function evaluateEnv(
  cfg: EnvEvaluateConfig | undefined,
  origin: string,
): EnvMatch | null {
  if (!cfg?.domains) return null;

  const whitelist = cfg.envBadge?.whitelist ?? [];
  if (whitelist.length > 0 && !whitelist.some((d) => matchDomain(d, origin))) {
    return null;
  }

  for (const [domain, env] of Object.entries(cfg.domains)) {
    if (matchDomain(domain, origin)) {
      return { name: env.name, tags: env.tags };
    }
  }
  return null;
}

/** 路由监听器（单例：重复 init 不重复安装） */
let routeWatcher: SpaRouteWatcher | null = null;

export async function initEnvIndicator() {
  await refreshEnvBadge();
  installRouteWatcher();
}

/** 安装 SPA 路由监听（幂等） */
function installRouteWatcher(): void {
  if (routeWatcher) return;
  routeWatcher = watchSpaRoutes(window, () => {
    void refreshEnvBadge();
  });
}

/**
 * 读取账号切换配置 + 生效的 envBadge。
 * 走 getConfig 享受缺失字段补齐（ADR-0003 D5）；envBadge 缺失时按默认值渲染。
 */
async function readEffectiveConfig(): Promise<{
  accountCfg: AccountSwitchConfig | undefined;
  badge: EnvBadgeConfig;
}> {
  const accountCfg = await getConfig<AccountSwitchConfig>(
    'account-switch',
    ACCOUNT_SWITCH_CONFIG_DEFAULTS,
  );
  const badge = accountCfg?.envBadge ?? {
    enabled: false,
    position: 'bottom-right',
    whitelist: [],
  };
  return { accountCfg, badge };
}

/**
 * 读取生效的指示器配置（content script 的启用判断与刷新共用同一事实源）。
 * envBadge.enabled 是主开关；envBadge 缺失而旧 key 存在时按旧配置渲染。
 */
export async function loadEnvBadgeConfig(): Promise<EnvBadgeConfig> {
  return (await readEffectiveConfig()).badge;
}

/** refresh 序号：路由密集变化时多次 refresh 并发，只应用最新一次的结果 */
let refreshSeq = 0;

/** 读取配置重新评估当前页面，并应用 badge 显示/更新/移除 */
async function refreshEnvBadge(): Promise<void> {
  const seq = ++refreshSeq;
  try {
    const { accountCfg, badge } = await readEffectiveConfig();
    if (seq !== refreshSeq) return; // 已有更新的评估，丢弃过期结果

    // enabled 每次刷新都重新生效：中途关闭时立即移除角标，DOM 零残留
    if (!badge.enabled) {
      applyEnvBadge(null, badge.position);
      return;
    }
    applyEnvBadge(
      evaluateEnv(
        { domains: accountCfg?.domains, envBadge: badge },
        window.location.origin,
      ),
      badge.position,
    );
  } catch {
    // 忽略
  }
}

/**
 * 应用评估结果到 DOM：
 * - 不匹配 → 移除 host 节点（含 Shadow Root），DOM 零残留
 * - 已存在 → 更新文本、颜色与位置（环境或配置变化）
 * - 不存在 → 创建 host + Shadow Root 并渲染 badge
 */
function applyEnvBadge(matched: EnvMatch | null, position: EnvBadgePosition): void {
  const existing = document.getElementById(HOST_ID);

  if (!matched) {
    existing?.remove();
    return;
  }

  // 环境色与卡片色点共用 tagColor（account-env-view）：取第一个可识别的 tag
  const color = tagColor(matched.tags.find((t) => normalizeEnvTag(t) !== undefined));
  const hostStyle = hostCssText(position);

  if (existing?.shadowRoot) {
    existing.style.cssText = hostStyle;
    const badge = existing.shadowRoot.querySelector<HTMLElement>('.badge');
    const label = existing.shadowRoot.querySelector<HTMLElement>('.label');
    if (badge) badge.style.background = color;
    if (label) label.textContent = matched.name;
    return;
  }

  renderBadge(matched.name, color, hostStyle);
}

/** host 节点样式：fixed 定位 + 适中 z-index，host 本身不拦截点击 */
function hostCssText(position: EnvBadgePosition): string {
  return `
    position: fixed;
    ${POSITION_STYLES[position]}
    z-index: 9999;
    pointer-events: none;
  `;
}

/**
 * Shadow Root 内的样式：紧凑小 pill，始终显示环境名，
 * 平时半透明确认存在感低，hover 时提亮。样式与外界双向隔离。
 */
const BADGE_CSS = `
  .badge {
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    height: 20px;
    padding: 0 8px;
    border-radius: 9999px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
    opacity: 0.75;
    pointer-events: auto;
    cursor: default;
    transition: opacity 0.15s ease-out;
  }
  .badge:hover {
    opacity: 1;
  }
  .label {
    white-space: nowrap;
    font: 600 11px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #fff;
  }
`;

function renderBadge(name: string, color: string, hostStyle: string): void {
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = hostStyle;

  const shadowRoot = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = BADGE_CSS;
  shadowRoot.appendChild(style);

  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.style.background = color;

  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = name;

  badge.appendChild(label);
  shadowRoot.appendChild(badge);

  document.body.appendChild(host);
}
