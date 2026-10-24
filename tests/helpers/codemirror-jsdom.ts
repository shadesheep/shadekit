/**
 * CodeMirror 6 在 jsdom 中需要的最小 polyfill。
 * 在测试文件的 beforeAll 中调用一次即可。
 */
export function setupCodemirrorJsdom(): void {
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number;
    window.cancelAnimationFrame = (id: number) =>
      clearTimeout(id as unknown as NodeJS.Timeout);
  }
  const zeroRect = {
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0,
    width: 0, height: 0, toJSON: () => ({}),
  } as DOMRect;
  Range.prototype.getBoundingClientRect = () => zeroRect;
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
}
