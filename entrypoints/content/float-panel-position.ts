interface Point {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 12;


/** 下方优先；下方空间不足时翻到锚点上方，最终始终收拢到视口内。 */
export function getFloatPanelPosition(
  anchor: Point,
  panel: Size,
  viewport: Size,
): Point {
  const maxLeft = Math.max(
    VIEWPORT_MARGIN,
    viewport.width - panel.width - VIEWPORT_MARGIN,
  );
  const maxTop = Math.max(
    VIEWPORT_MARGIN,
    viewport.height - panel.height - VIEWPORT_MARGIN,
  );

  const belowTop = anchor.y + ANCHOR_GAP;
  const preferredTop =
    belowTop + panel.height <= viewport.height - VIEWPORT_MARGIN
      ? belowTop
      : anchor.y - panel.height - ANCHOR_GAP;

  return {
    x: Math.min(
      Math.max(anchor.x + ANCHOR_GAP, VIEWPORT_MARGIN),
      maxLeft,
    ),
    y: Math.min(Math.max(preferredTop, VIEWPORT_MARGIN), maxTop),
  };
}
