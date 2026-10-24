import { safeStorageSet } from './safe-storage';
import { showToast } from './use-toast';

const STORAGE_PREFIX = 'devtools-';

/**
 * 配置 schema 版本号：导出文件附带 `__version`，导入时按版本走迁移链
 * （见本文件底部 `migrateConfig`）。修改配置结构时需同步递增此值并补充
 * 对应迁移步骤。
 *
 * v2：env-indicator 并入 account-switch.envBadge（ADR-0017 D1）。
 */
export const CONFIG_VERSION = 2;

/**
 * 每个工具的配置独立存储为顶层 key：
 *   { "devtools-account-switch": {...}, "devtools-json-formatter": {...}, "devtools-state": {...} }
 *
 * 独立 key 避免多个工具并发写入时互相覆盖。
 */
export function keyFor(toolId: string): string {
  return STORAGE_PREFIX + toolId;
}

/**
 * 读取单个工具配置。
 *
 * @param defaults 可选的顶层默认值（ADR-0003 D5）：传入时与存储结果做顶层浅合并，
 *   配置中缺失的新增字段被补齐，已有字段不被覆盖。存储中没有任何配置时仍返回
 *   undefined（保留调用方「未配置」的报错/降级分支，defaults 只补字段不造配置）。
 *   不传时不做合并，原样返回存储值。
 */
export async function getConfig<T>(
  toolId: string,
  defaults?: T,
): Promise<T | undefined> {
  const result = await chrome.storage.local.get([keyFor(toolId)]);
  const stored = result[keyFor(toolId)] as T | undefined;
  if (stored === undefined || defaults === undefined) return stored;
  return {
    ...(defaults as Record<string, unknown>),
    ...(stored as Record<string, unknown>),
  } as T;
}

/**
 * 写入单个工具配置（整体覆盖）
 * @returns 是否写入成功；失败时已通过 toast 提示用户，调用方不应再展示「保存成功」
 */
export async function setConfig<T>(toolId: string, data: T): Promise<boolean> {
  const result = await safeStorageSet({ [keyFor(toolId)]: data });
  return result.ok;
}

/**
 * 保存工具配置并给出统一的用户反馈：
 * - 成功：弹「已保存」成功 Toast（可用 message 自定义文案）
 * - 失败：safeStorageSet 已弹出含「复制详情」的错误 Toast，此处不再重复提示，
 *         也绝不展示成功反馈（杜绝「保存成功」假反馈）
 *
 * 选项页各工具 Config 的保存入口应统一走本函数。
 *
 * @returns 是否写入成功
 */
export async function setConfigWithFeedback<T>(
  toolId: string,
  data: T,
  message = '已保存',
): Promise<boolean> {
  const ok = await setConfig(toolId, data);
  if (ok) showToast(message, 'success');
  return ok;
}

/**
 * 跨上下文写锁（Web Locks API）。
 *
 * chrome.storage 不提供读-改-写原子性；多开 options 页分属不同 JS 上下文，
 * 模块级互斥锁无法跨页面生效。navigator.locks 在同一浏览器内跨上下文互斥，
 * 把「读最新 → 合并 → 写回」串行化后，并发保存不同字段不会互相覆盖。
 * 无 locks 的环境（测试、非安全上下文）降级为直接执行。
 */
async function withStorageLock<T>(
  lockName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const locks =
    typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return fn();
  return locks.request(lockName, fn);
}

/**
 * 增量合并写入单个工具配置：读最新 → 只覆盖 patch 中的字段 → 写回。
 *
 * 多开 options 页同时修改同一工具的不同字段时，整体写回（setConfig）会用
 * 本页的过期内存状态覆盖另一页的修改；增量合并只动本次修改的字段，双方
 * 修改都能保留。保存路径应尽量使用本函数，仅导入等确需整体替换的场景用 setConfig。
 *
 * @returns 是否写入成功；失败时已通过 toast 提示用户
 */
export async function updateConfig<T extends object>(
  toolId: string,
  patch: Partial<T>,
): Promise<boolean> {
  return withStorageLock(`devtools-lock-${keyFor(toolId)}`, async () => {
    const latest = (await getConfig<T>(toolId)) ?? ({} as T);
    const merged = { ...latest, ...patch } as T;
    const result = await safeStorageSet({ [keyFor(toolId)]: merged });
    return result.ok;
  });
}

/**
 * 配置迁移函数（导入路径）：按 `__version` 逐级执行迁移链。
 *
 * 当前 CONFIG_VERSION=2 是首发公开版本，尚无更早版本需要迁移；保留入口
 * 以便未来新增 v2 → v3 等步骤时只追加 `if (from === N)` 分支。
 *
 * @param data - 导入的配置数据（key 无前缀，与 config-transfer 的导出格式一致）
 * @returns 迁移后的配置数据
 */
export function migrateConfig(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const version = (data.__version as number) ?? 0;
  if (version >= CONFIG_VERSION) return data;
  const out = { ...data, __version: CONFIG_VERSION };
  return out;
}

/**
 * 初始化默认配置
 * @param isValid 可选验证器，当配置已存在但内容无效时，也会写入默认值
 */
export async function initConfig<T>(
  toolId: string,
  defaults: T,
  meta: Record<string, unknown> = {},
  isValid?: (config: unknown) => boolean,
): Promise<T> {
  const result = await chrome.storage.local.get([keyFor(toolId)]);
  const current = result[keyFor(toolId)] as T | undefined;

  const needsWrite = current === undefined || (isValid && !isValid(current));
  if (needsWrite) {
    // 默认值初始化属启动期写入，失败不弹提示（下次加载自动重试）
    await safeStorageSet({ [keyFor(toolId)]: defaults }, { notify: false });
    if (Object.keys(meta).length > 0) {
      const existing = await chrome.storage.local.get([keyFor('_meta')]);
      const currentMeta = (existing[keyFor('_meta')] ?? {}) as Record<
        string,
        unknown
      >;
      await safeStorageSet(
        { [keyFor('_meta')]: { ...currentMeta, ...meta } },
        { notify: false },
      );
    }
    return defaults;
  }

  return current as T;
}
