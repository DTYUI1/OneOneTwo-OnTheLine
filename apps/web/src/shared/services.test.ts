import { describe, expect, it } from "vitest";
import { isDdsService, serviceLabel, serviceShort } from "./services";

const SERVICES = [
  { id: "101", name: "Служба 101" },
  { id: "GKH", name: "ЖКХ" },
];

describe("подпись службы", () => {
  it("берёт название справочника, а не идентификатор латиницей", () => {
    expect(serviceLabel(SERVICES, "GKH")).toBe("ЖКХ");
    expect(serviceLabel(SERVICES, "101")).toBe("Служба 101");
  });

  it("без справочника и без службы подписи нет", () => {
    expect(serviceLabel(undefined, "GKH")).toBe("");
    expect(serviceLabel(SERVICES, null)).toBe("");
    // Службы нет в справочнике — идентификатор всё равно не показываем.
    expect(serviceLabel(SERVICES, "MOSLIFT")).toBe("");
  });
});

describe("короткая подпись службы", () => {
  it("цифровая ДДС — номером, как в АРМ-112; остальные — названием", () => {
    expect(serviceShort(SERVICES, "101")).toBe("101");
    expect(serviceShort(SERVICES, "GKH")).toBe("ЖКХ");
  });

  it("справочника нет — остаётся идентификатор, пустой строки на экране не будет", () => {
    expect(serviceShort(undefined, "GKH")).toBe("GKH");
  });
});

describe("служба ДДС", () => {
  it("Система-112 — не ДДС", () => {
    expect(isDdsService({ category: "system112" })).toBe(false);
    expect(isDdsService({ category: "dds" })).toBe(true);
  });
});
