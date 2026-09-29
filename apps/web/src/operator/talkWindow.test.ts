import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampTalk,
  centerTalk,
  fitTalkSize,
  loadTalkPreferences,
  placeTalkMenu,
  resizeTalk,
  saveTalkPreferences,
  TALK_EDGES,
  TALK_WINDOW_KEY,
} from "./talkWindow";

afterEach(() => vi.unstubAllGlobals());

describe("плавающее окно разговора", () => {
  const viewport = { width: 1366, height: 650 };
  const size = { width: 700, height: 320 };
  it("размер меняется за любой край и угол, противоположный край на месте", () => {
    const origin = { left: 300, top: 150, width: 700, height: 340 };
    expect(TALK_EDGES.map((item) => item.name)).toEqual([
      "n",
      "s",
      "w",
      "e",
      "nw",
      "ne",
      "sw",
      "se",
    ]);
    // Левый край влево на 100: окно шире, правый край (1000) на месте.
    expect(resizeTalk(origin, { x: -1, y: 0 }, -100, 0, viewport)).toEqual({
      left: 200,
      top: 150,
      width: 800,
      height: 340,
    });
    // Верхний левый угол: и ширина, и высота, нижний правый угол на месте.
    expect(resizeTalk(origin, { x: -1, y: -1 }, -50, -40, viewport)).toEqual({
      left: 250,
      top: 110,
      width: 750,
      height: 380,
    });
    // Нижний край вниз: верх на месте, высота не выходит за экран (650 − 8).
    expect(resizeTalk(origin, { x: 0, y: 1 }, 0, 500, viewport)).toEqual({
      left: 300,
      top: 150,
      width: 700,
      height: 492,
    });
  });
  it("край не уводит окно за экран и не сжимает меньше минимума", () => {
    const origin = { left: 300, top: 150, width: 700, height: 340 };
    // Левый край — не левее 8 px от края экрана.
    expect(resizeTalk(origin, { x: -1, y: 0 }, -1000, 0, viewport)).toEqual({
      left: 8,
      top: 150,
      width: 992,
      height: 340,
    });
    // Сжатие — до 600 × 320, правый и нижний края остаются на месте.
    expect(resizeTalk(origin, { x: -1, y: -1 }, 500, 500, viewport)).toEqual({
      left: 400,
      top: 170,
      width: 600,
      height: 320,
    });
  });
  it("открывается по центру и ограничивает размер экраном", () => {
    expect(centerTalk(size, viewport)).toEqual({ left: 333, top: 165 });
    expect(fitTalkSize({ width: 10, height: 10 }, viewport)).toEqual({
      width: 600,
      height: 320,
    });
    expect(fitTalkSize({ width: 4000, height: 4000 }, viewport)).toEqual({
      width: 1350,
      height: 634,
    });
    expect(fitTalkSize(size, { width: 500, height: 300 })).toEqual({
      width: 484,
      height: 284,
    });
  });
  it("при растягивании сохраняет верхний левый угол и не выходит за край", () => {
    expect(
      fitTalkSize({ width: 4000, height: 4000 }, viewport, {
        left: 400,
        top: 200,
      }),
    ).toEqual({ width: 958, height: 442 });
  });
  it("сохраняет смещение внутри экрана и прижимает к четырём краям", () => {
    expect(clampTalk({ left: 120, top: 60 }, size, viewport)).toEqual({
      left: 120,
      top: 60,
    });
    expect(clampTalk({ left: -400, top: -90 }, size, viewport)).toEqual({
      left: 8,
      top: 8,
    });
    expect(clampTalk({ left: 2000, top: 900 }, size, viewport)).toEqual({
      left: 658,
      top: 322,
    });
  });
  it("возвращает окно в экран после уменьшения браузера", () => {
    const point = clampTalk({ left: 1100, top: 700 }, size, viewport);
    expect(point.left + size.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(point.top + size.height).toBeLessThanOrEqual(viewport.height - 8);
  });
  it("положение и свёрнутость переживают новый звонок и перезагрузку", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    expect(loadTalkPreferences()).toEqual({
      position: null,
      size: null,
      collapsed: false,
    });
    const saved = { position: { left: 150, top: 75 }, size, collapsed: true };
    saveTalkPreferences(saved);
    expect(values.has(TALK_WINDOW_KEY)).toBe(true);
    expect(loadTalkPreferences()).toEqual(saved);
    saveTalkPreferences({ position: null, size: null, collapsed: true });
    expect(loadTalkPreferences()).toEqual({
      position: null,
      size: null,
      collapsed: true,
    });
  });
  it("читает прежние настройки, в которых размер ещё не сохранялся", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => '{"position":{"left":50,"top":60},"collapsed":true}',
    });
    expect(loadTalkPreferences()).toEqual({
      position: { left: 50, top: 60 },
      size: null,
      collapsed: true,
    });
  });
  it.each([
    "{",
    "null",
    ' {"collapsed":"yes"}',
    '{"collapsed":false,"position":{"left":"1","top":20}}',
    '{"collapsed":false,"position":{"left":1e999,"top":20}}',
    '{"collapsed":false,"size":{"width":-1,"height":300}}',
    '{"collapsed":false,"size":{"width":600,"height":"300"}}',
  ])("игнорирует повреждённые настройки: %s", (value) => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(loadTalkPreferences()).toEqual({
      position: null,
      size: null,
      collapsed: false,
    });
  });
  it("работает без доступа к хранилищу", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("закрыто");
      },
      setItem: () => {
        throw new Error("закрыто");
      },
    });
    expect(loadTalkPreferences()).toEqual({
      position: null,
      size: null,
      collapsed: false,
    });
    expect(() =>
      saveTalkPreferences({ position: null, size: null, collapsed: true }),
    ).not.toThrow();
  });
  it("меню у верха раскрывается вниз, у низа — вверх; не выходит по ширине", () => {
    const menu = { width: 460, height: 200 };
    const above = placeTalkMenu(
      { left: 0, top: 8, width: 80, height: 24 },
      menu,
      viewport,
    );
    expect(above.top).toBe(36);
    expect(above.left).toBe(8);
    const below = placeTalkMenu(
      { left: 1250, top: 600, width: 90, height: 24 },
      menu,
      viewport,
    );
    expect(below.top + menu.height).toBeLessThan(600);
    expect(below.left + menu.width).toBeLessThanOrEqual(viewport.width - 8);
  });
});
