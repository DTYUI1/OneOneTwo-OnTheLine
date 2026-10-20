import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampWindow,
  centerPoint,
  dockPoint,
  fitWindowSize,
  loadWindowPreferences,
  placeWindowMenu,
  resizeWindow,
  saveWindowPreferences,
  DEFAULT_WINDOW_SIZE,
  WINDOW_EDGES,
  windowSize,
} from "./floatingWindow";

afterEach(() => vi.unstubAllGlobals());

const KEY = "operator-talk-window";

describe("плавающее окно разговора", () => {
  const viewport = { width: 1366, height: 650 };
  const size = { width: 700, height: 320 };
  it("размер меняется за любой край и угол, противоположный край на месте", () => {
    const origin = { left: 300, top: 150, width: 700, height: 340 };
    expect(WINDOW_EDGES.map((item) => item.name)).toEqual([
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
    expect(resizeWindow(origin, { x: -1, y: 0 }, -100, 0, viewport)).toEqual({
      left: 200,
      top: 150,
      width: 800,
      height: 340,
    });
    // Верхний левый угол: и ширина, и высота, нижний правый угол на месте.
    expect(resizeWindow(origin, { x: -1, y: -1 }, -50, -40, viewport)).toEqual({
      left: 250,
      top: 110,
      width: 750,
      height: 380,
    });
    // Нижний край вниз: верх на месте, высота не выходит за экран (650 − 8).
    expect(resizeWindow(origin, { x: 0, y: 1 }, 0, 500, viewport)).toEqual({
      left: 300,
      top: 150,
      width: 700,
      height: 492,
    });
  });
  it("край не уводит окно за экран и не сжимает меньше минимума", () => {
    const origin = { left: 300, top: 150, width: 700, height: 340 };
    // Левый край — не левее 8 px от края экрана.
    expect(resizeWindow(origin, { x: -1, y: 0 }, -1000, 0, viewport)).toEqual({
      left: 8,
      top: 150,
      width: 992,
      height: 340,
    });
    // Сжатие — до 600 × 320, правый и нижний края остаются на месте.
    expect(resizeWindow(origin, { x: -1, y: -1 }, 500, 500, viewport)).toEqual({
      left: 400,
      top: 170,
      width: 600,
      height: 320,
    });
  });
  it("открывается по центру и ограничивает размер экраном", () => {
    expect(centerPoint(size, viewport)).toEqual({ left: 333, top: 165 });
    expect(fitWindowSize({ width: 10, height: 10 }, viewport)).toEqual({
      width: 600,
      height: 320,
    });
    expect(fitWindowSize({ width: 4000, height: 4000 }, viewport)).toEqual({
      width: 1350,
      height: 634,
    });
    expect(fitWindowSize(size, { width: 500, height: 300 })).toEqual({
      width: 484,
      height: 284,
    });
  });
  it("прижатое окно — в правом нижнем углу с отступами, не за краем", () => {
    const dock = { right: 16, bottom: 64 };
    expect(dockPoint(size, viewport, dock)).toEqual({ left: 650, top: 266 });
    // Свёрнутое — одна шапка у того же нижнего края.
    expect(dockPoint({ width: 700, height: 30 }, viewport, dock)).toEqual({
      left: 650,
      top: 556,
    });
    expect(dockPoint({ width: 1366, height: 650 }, viewport, dock)).toEqual({
      left: 8,
      top: 8,
    });
  });
  it("при растягивании сохраняет верхний левый угол и не выходит за край", () => {
    expect(
      fitWindowSize({ width: 4000, height: 4000 }, viewport, {
        left: 400,
        top: 200,
      }),
    ).toEqual({ width: 958, height: 442 });
  });
  it("сохраняет смещение внутри экрана и прижимает к четырём краям", () => {
    expect(clampWindow({ left: 120, top: 60 }, size, viewport)).toEqual({
      left: 120,
      top: 60,
    });
    expect(clampWindow({ left: -400, top: -90 }, size, viewport)).toEqual({
      left: 8,
      top: 8,
    });
    expect(clampWindow({ left: 2000, top: 900 }, size, viewport)).toEqual({
      left: 658,
      top: 322,
    });
  });
  it("возвращает окно в экран после уменьшения браузера", () => {
    const point = clampWindow({ left: 1100, top: 700 }, size, viewport);
    expect(point.left + size.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(point.top + size.height).toBeLessThanOrEqual(viewport.height - 8);
  });
  it("положение и свёрнутость переживают новый звонок и перезагрузку", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    expect(loadWindowPreferences(KEY)).toEqual({
      position: null,
      size: null,
      collapsed: false,
    });
    const saved = { position: { left: 150, top: 75 }, size, collapsed: true };
    saveWindowPreferences(KEY, saved);
    expect(values.has(KEY)).toBe(true);
    expect(loadWindowPreferences(KEY)).toEqual(saved);
    saveWindowPreferences(KEY, { position: null, size: null, collapsed: true });
    expect(loadWindowPreferences(KEY)).toEqual({
      position: null,
      size: null,
      collapsed: true,
    });
  });
  it("читает прежние настройки, в которых размер ещё не сохранялся", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => '{"position":{"left":50,"top":60},"collapsed":true}',
    });
    expect(loadWindowPreferences(KEY)).toEqual({
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
    expect(loadWindowPreferences(KEY)).toEqual({
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
    expect(loadWindowPreferences(KEY)).toEqual({
      position: null,
      size: null,
      collapsed: false,
    });
    expect(() =>
      saveWindowPreferences(KEY, {
        position: null,
        size: null,
        collapsed: true,
      }),
    ).not.toThrow();
  });
  it("меню у верха раскрывается вниз, у низа — вверх; не выходит по ширине", () => {
    const menu = { width: 460, height: 200 };
    const above = placeWindowMenu(
      { left: 0, top: 8, width: 80, height: 24 },
      menu,
      viewport,
    );
    expect(above.top).toBe(36);
    expect(above.left).toBe(8);
    const below = placeWindowMenu(
      { left: 1250, top: 600, width: 90, height: 24 },
      menu,
      viewport,
    );
    expect(below.top + menu.height).toBeLessThan(600);
    expect(below.left + menu.width).toBeLessThanOrEqual(viewport.width - 8);
  });
});

describe("окно телефона ДДС (GP-09) — та же геометрия, что у окна разговора 112", () => {
  const viewport = { width: 1366, height: 768 };
  it("размер по умолчанию 760 × 340, не меньше 600 × 320 — содержимое на него не влияет", () => {
    expect(DEFAULT_WINDOW_SIZE).toEqual({ width: 760, height: 340 });
    // Размер считается только из сохранённого и экрана: состояние звонка в расчёт не входит.
    expect(fitWindowSize(DEFAULT_WINDOW_SIZE, viewport)).toEqual({
      width: 760,
      height: 340,
    });
    expect(fitWindowSize({ width: 100, height: 100 }, viewport)).toEqual({
      width: 600,
      height: 320,
    });
    expect(
      fitWindowSize(DEFAULT_WINDOW_SIZE, { width: 1920, height: 1080 }),
    ).toEqual({ width: 760, height: 340 });
  });
  it("состояние звонка размер не меняет: контакты, гудки, разговор, итог — одно окно", () => {
    // Размер считает только windowSize: сохранённый размер и экран. Состояния звонка и
    // содержимого (длина ленты, варианты ответа, входящий) в его аргументах нет.
    const saved = { width: 640, height: 330 };
    const sizes = ["contacts", "dialing", "ringing", "talking", "ended"].map(
      () => windowSize(saved, viewport, null),
    );
    expect(
      new Set(sizes.map((size) => `${size.width}×${size.height}`)),
    ).toEqual(new Set(["640×330"]));
    expect(windowSize(null, viewport, null)).toEqual({
      width: 760,
      height: 340,
    });
    expect(windowSize(null, { width: 1920, height: 1080 }, null)).toEqual({
      width: 760,
      height: 340,
    });
    // Сохранённый размер больше экрана — окно в пределах экрана, не меньше 600 × 320.
    expect(
      windowSize(
        { width: 3000, height: 2000 },
        { width: 1366, height: 768 },
        null,
      ),
    ).toEqual({ width: 1350, height: 752 });
  });
  it("свёрнутый телефон — шапка той же ширины (макет), свёрнутый разговор 112 — 250", () => {
    const head = { head: 28, keepWidth: true };
    expect(windowSize(null, viewport, head)).toEqual({
      width: 760,
      height: 28,
    });
    expect(windowSize({ width: 640, height: 330 }, viewport, head)).toEqual({
      width: 640,
      height: 28,
    });
    expect(windowSize(null, viewport, { head: 28, keepWidth: false })).toEqual({
      width: 250,
      height: 28,
    });
  });
  it("место и размер телефона и разговора 112 хранятся отдельно", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const phone = {
      position: { left: 40, top: 50 },
      size: { width: 640, height: 330 },
      collapsed: false,
    };
    saveWindowPreferences("dds-phone-window", phone);
    expect(loadWindowPreferences("dds-phone-window")).toEqual(phone);
    expect(loadWindowPreferences(KEY)).toEqual({
      position: null,
      size: null,
      collapsed: false,
    });
  });
});
