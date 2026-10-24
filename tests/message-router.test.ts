/**
 * ADR-0003 D1 — Background Router 按消息 type 全局路由
 *
 * ① 跨所有工具的 backgroundHandlers 按 type 建路由表（不再依赖 toolId）
 * ② 启动期校验 type 唯一性：两个工具声明同一 type 立即抛错（fail fast）
 * ③ 不带 toolId 的消息（扩展市场等）能正确路由到声明该 type 的工具
 */
import { describe, it, expect } from 'vitest';
import { buildMessageRouteTable } from '../entrypoints/shared/message-router';
import { allTools } from '../entrypoints/shared/tool-definitions';
import type { ToolDefinition } from '../entrypoints/shared/types';

function makeTool(
  id: string,
  handlers?: Record<
    string,
    (msg: never, sender: chrome.runtime.MessageSender) => Promise<unknown>
  >,
): ToolDefinition {
  // 测试使用虚构 type 验证建表机制本身；真实注册表的 type 合法性由
  // ToolBackgroundHandlers 的映射类型在编译期保证（见 shared/types.ts）。
  return {
    id,
    name: id,
    description: '',
    icon: '',
    enabledByDefault: false,
    backgroundHandlers:
      handlers as unknown as ToolDefinition['backgroundHandlers'],
  };
}

describe('buildMessageRouteTable', () => {
  it('跨工具按 type 路由，handler 来自声明该 type 的工具', () => {
    const handlerA = async () => 'a';
    const handlerB = async () => 'b';
    const table = buildMessageRouteTable([
      makeTool('tool-a', { TYPE_A: handlerA }),
      makeTool('tool-b', { TYPE_B: handlerB }),
    ]);
    expect(table.get('TYPE_A')).toBe(handlerA);
    expect(table.get('TYPE_B')).toBe(handlerB);
    expect(table.size).toBe(2);
  });

  it('工具无 backgroundHandlers 时被跳过', () => {
    const table = buildMessageRouteTable([
      makeTool('tool-none', undefined),
      makeTool('tool-a', { TYPE_A: async () => null }),
    ]);
    expect(table.size).toBe(1);
  });

  it('两个工具声明同一 type 时启动期抛错（fail fast）', () => {
    expect(() =>
      buildMessageRouteTable([
        makeTool('tool-a', { DUP: async () => null }),
        makeTool('tool-b', { DUP: async () => null }),
      ]),
    ).toThrow(/DUP/);
  });

  it('真实注册表 type 全部唯一且能建表', () => {
    const table = buildMessageRouteTable(allTools);
    // 可达性守护：以下是不带 toolId 的发送方依赖的消息 type（账号切换/
    // 快捷登录），若被 toolId 路由丢弃会导致消息丢失。新增此类消息时
    // 需同步加入，否则该测试静默欠覆盖。
    for (const type of ['SWITCH_ACCOUNT', 'QUICK_LOGIN']) {
      expect(table.has(type), `缺少路由: ${type}`).toBe(true);
    }
  });
});
