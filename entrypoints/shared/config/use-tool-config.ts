import { nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import { getConfig, setConfig, updateConfig } from '../tool-config';
import { showToast } from '../use-toast';

/** 自动保存状态:idle 常态 / saved 刚保存成功(短暂闪现后回落 idle) */
export type SaveState = 'idle' | 'saved';

export interface UseToolConfigOptions<T> {
  /**
   * 保存前归一化(直接原地修改,需幂等)。
   * 用于边界钳制,如 count 限制在 1-1000;在 watch 回调里执行,
   * 钳制后的值同时回流到输入框。
   */
  normalize?: (config: T) => void;
  /**
   * 加载后从 ref 中剔除的键:本页不编辑、由工具页自己维护的字段
   * (如 mock-data 的 fields)。剔除后增量保存永不触碰这些键,
   * 也避免 deep watch 大数组。string 而非 keyof T:允许剔除页面类型
   * 之外、由其他上下文写入存储的键。
   */
  omit?: string[];
  /** 防抖毫秒数,默认 400(与工具主页面 App.vue 的自动保存一致) */
  debounceMs?: number;
}

/**
 * Config Kit 的保存底座(ADR-0007 Auto-save 范式)。
 *
 * - 加载:getConfig(toolId, defaults) 顶层浅合并,配置中缺失的新增字段自动补齐
 * - 保存:deep watch + 防抖 → updateConfig 增量合并(跨上下文写锁),
 *   页内零 `@change` 保存代码;成功只闪「✓ 已保存」轻提示(saveState),
 *   失败由 safeStorageSet 弹错误 toast
 * - save():显式增量保存,返回是否成功——给按钮类动作用
 * - replace():整体覆盖写(setConfig),仅用于「清空字段列表」这类
 *   需要删除 key 的破坏性动作;注意不做合并,与工具页并发编辑存在覆写窗口
 */
export function useToolConfig<T extends object>(
  toolId: string,
  defaults: T,
  opts: UseToolConfigOptions<T> = {},
) {
  const { normalize, omit, debounceMs = 400 } = opts;

  // 深拷贝默认值:浅展开会让嵌套数组/对象与调用方的 DEFAULTS 常量共享引用,
  // 一处编辑污染默认值(配置按约定皆可 JSON 序列化)
  const config = ref(JSON.parse(JSON.stringify(defaults))) as Ref<T>;
  /** 初始加载完成前 watch 不触发保存(对齐 App.vue 的 configLoaded 守卫) */
  const loaded = ref(false);
  const saveState = ref<SaveState>('idle');

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let savedResetTimer: ReturnType<typeof setTimeout> | null = null;

  function flashSaved() {
    saveState.value = 'saved';
    if (savedResetTimer) clearTimeout(savedResetTimer);
    savedResetTimer = setTimeout(() => {
      saveState.value = 'idle';
    }, 1600);
  }

  /**
   * 深拷贝为纯数据(剥离响应式 Proxy):
   * - 嵌套数组/对象(如环境白名单 domains)直接进 chrome.storage 时,
   *   Firefox 的 structured-clone 会因 Proxy 抛 DataCloneError
   * - 落盘的应是快照,保存后继续编辑内存不污染已写数据
   * (对齐 account-switch saveFields 的 JSON 深拷贝先例;配置按约定皆可 JSON 序列化)
   */
  function snapshot(): T {
    return JSON.parse(JSON.stringify(config.value)) as T;
  }

  /** 显式增量保存(合并语义,不丢其他上下文写入的字段) */
  async function save(): Promise<boolean> {
    const ok = await updateConfig<T>(toolId, snapshot());
    if (ok) flashSaved();
    return ok;
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void save(), debounceMs);
  }

  /** 整体覆盖 + 成功 toast,供「清空/重置」类破坏性按钮动作使用 */
  async function replace(message = '已保存'): Promise<boolean> {
    const ok = await setConfig(toolId, snapshot());
    if (ok) showToast(message, 'success');
    return ok;
  }

  onMounted(async () => {
    const saved = await getConfig<T>(toolId, defaults);
    if (saved) {
      if (omit) {
        for (const key of omit) {
          delete (saved as Record<string, unknown>)[key];
        }
      }
      config.value = saved;
    }
    // watch 为 pre 异步刷新:config.value 赋值后回调排入微任务,若同步置 loaded=true,
    // 回调运行时守卫已放行,加载本身会被误判为用户修改而触发一次冗余保存(闪「已保存」)。
    // nextTick 让本次 load 触发的 watch 回调在 loaded=false 时跑完(被守卫丢弃),再开闸。
    await nextTick();
    loaded.value = true;
  });

  watch(
    config,
    () => {
      if (!loaded.value) return;
      // 钳制先回流到 ref(幂等,第二次 watch 触发时值已稳定,防抖合并为一次写)
      normalize?.(config.value);
      scheduleSave();
    },
    { deep: true },
  );

  onUnmounted(() => {
    if (saveTimer) clearTimeout(saveTimer);
    if (savedResetTimer) clearTimeout(savedResetTimer);
  });

  return { config, loaded, saveState, save, replace };
}
