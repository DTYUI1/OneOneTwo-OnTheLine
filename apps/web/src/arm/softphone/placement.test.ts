import { describe, expect, it } from "vitest";
import {
  PANEL_GAP,
  PANEL_MIN,
  panelSize,
  placePanel,
  reserveHeight,
} from "./placement";

// Замер на АРМ 1366×768: карточка видна от 70 до 752 px, полоса телефона
// стоит внизу карточки — 545…675. Снизу остаётся 77 px, сверху 467.
const card = { top: 70, bottom: 752 };

describe("placePanel", () => {
  it("внизу карточки раскрывается вверх и помещается в видимую часть", () => {
    const place = placePanel({ top: 545, bottom: 675 }, card);
    expect(place.up).toBe(true);
    expect(place.maxHeight).toBe(545 - 70 - PANEL_GAP);
  });

  it("у верха карточки раскрывается вниз, как в шапке на снимке 06", () => {
    const place = placePanel({ top: 80, bottom: 120 }, card);
    expect(place.up).toBe(false);
    expect(place.maxHeight).toBe(752 - 120 - PANEL_GAP);
  });

  it("при равном месте остаётся вниз — это направление по умолчанию", () => {
    const place = placePanel({ top: 381, bottom: 441 }, card);
    expect(place.up).toBe(false);
  });

  it("в тесноте не сжимается до бесполезной щели", () => {
    const place = placePanel({ top: 90, bottom: 700 }, card);
    expect(place.maxHeight).toBe(PANEL_MIN);
  });
});

describe("panelSize", () => {
  it("вверх занимает место целиком: рост содержимого не двигает верх панели", () => {
    const size = panelSize({ up: true, maxHeight: 467 });
    expect(size.height).toBe(467);
    expect(size.maxHeight).toBe(467);
  });

  it("вниз высота по содержимому: верх и так стоит у полосы", () => {
    expect(panelSize({ up: false, maxHeight: 300 }).height).toBeNull();
  });
});

describe("reserveHeight", () => {
  it("разговор короче набора — место остаётся прежним", () => {
    expect(reserveHeight(312, 263)).toBe(312);
  });

  it("растёт до нового размера и округляется вверх до целого пикселя", () => {
    expect(reserveHeight(0, 311.2)).toBe(312);
  });
});
