import { describe, expect, it } from "vitest";
import {
  clampPoint,
  DEFAULT_CALL_SIZE,
  firstPlace,
  MIN_CALL_SIZE,
  PANEL_SLOT,
  resizeBox,
  WINDOW_EDGE,
} from "./callGeometry";

const screen = { width: 1920, height: 1080 };

describe("firstPlace", () => {
  it("на широкой карточке встаёт левее панели телефона, под полосой", () => {
    const strip = { left: 400, right: 1900, top: 150, bottom: 190 };
    const box = firstPlace(strip, { top: 60, bottom: 900 }, screen);
    expect(box.top).toBe(190 + WINDOW_EDGE);
    expect(box.left + box.width).toBe(1900 - PANEL_SLOT - WINDOW_EDGE);
    expect(box.height).toBe(DEFAULT_CALL_SIZE.height);
  });

  it("не опускается ниже строки служб с формой статуса", () => {
    const strip = { left: 400, right: 1900, top: 150, bottom: 190 };
    const box = firstPlace(strip, { top: 60, bottom: 480 }, screen);
    expect(box.top + box.height).toBeLessThanOrEqual(480 - WINDOW_EDGE);
  });

  it("на узкой полосе встаёт у левого края и заходит на панель как можно меньше", () => {
    // 1000 px: левее панели окну 400 px не хватает (нужно ≥ 1044 px).
    const strip = { left: 300, right: 1300, top: 150, bottom: 190 };
    const box = firstPlace(strip, { top: 60, bottom: 900 }, screen);
    expect(box.left).toBe(300 + WINDOW_EDGE);
    // Заход на зону панели — только недостающие пиксели, кнопки справа открыты.
    const overlap = box.left + box.width - (1300 - PANEL_SLOT);
    expect(overlap).toBe(WINDOW_EDGE + 400 - (1000 - PANEL_SLOT));
    expect(box.left + box.width).toBeLessThan(1300 - WINDOW_EDGE - 200);
  });

  it("при ширине полосы от 1044 px окно не заходит на панель", () => {
    const strip = { left: 300, right: 1344, top: 150, bottom: 190 };
    const box = firstPlace(strip, { top: 60, bottom: 900 }, screen);
    expect(box.left).toBeGreaterThanOrEqual(300 + WINDOW_EDGE);
    expect(box.left + box.width).toBeLessThanOrEqual(1344 - PANEL_SLOT);
  });

  it("полоса внизу карточки — окно над ней", () => {
    const strip = { left: 300, right: 1300, top: 545, bottom: 575 };
    const box = firstPlace(
      strip,
      { top: 70, bottom: 600 },
      {
        width: 1366,
        height: 768,
      },
    );
    expect(box.top + box.height).toBe(545 - WINDOW_EDGE);
  });
});

describe("resizeBox и clampPoint", () => {
  it("не делает окно меньше минимума и не выводит за экран", () => {
    const box = resizeBox(
      { left: 100, top: 100, width: 400, height: 360 },
      { x: 1, y: 1 },
      -1000,
      -1000,
      screen,
    );
    expect(box.width).toBe(MIN_CALL_SIZE.width);
    expect(box.height).toBe(MIN_CALL_SIZE.height);
    expect(clampPoint({ left: -50, top: 5000 }, box, screen)).toEqual({
      left: WINDOW_EDGE,
      top: screen.height - box.height - WINDOW_EDGE,
    });
  });
});
