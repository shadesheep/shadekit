import { describe, expect, it } from "vitest";
import { getFloatPanelPosition } from "../entrypoints/content/float-panel-position";

const viewport = { width: 1280, height: 800 };
const panel = { width: 300, height: 400 };

describe("getFloatPanelPosition", () => {
  it("下方空间充足时在锚点下方展开", () => {
    expect(
      getFloatPanelPosition({ x: 100, y: 100 }, panel, viewport),
    ).toEqual({ x: 112, y: 112 });
  });

  it("靠近视口底部时翻到锚点上方并保留边距", () => {
    const position = getFloatPanelPosition(
      { x: 400, y: 790 },
      panel,
      viewport,
    );

    expect(position).toEqual({ x: 412, y: 378 });
    expect(position.y + panel.height).toBeLessThanOrEqual(
      viewport.height - 8,
    );
  });

  it("上下空间都不足时收拢到视口顶部", () => {
    const position = getFloatPanelPosition(
      { x: 400, y: 300 },
      { width: 300, height: 500 },
      { width: 1280, height: 600 },
    );

    expect(position.y).toBe(8);
  });

  it("极小视口下仍保留最小边距", () => {
    expect(
      getFloatPanelPosition(
        { x: 230, y: 190 },
        panel,
        { width: 240, height: 200 },
      ),
    ).toEqual({ x: 8, y: 8 });
  });
});
