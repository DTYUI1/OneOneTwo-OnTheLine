import { describe, expect, it } from "vitest";
import {
  ABBREVIATIONS,
  commentClarity,
  expandAbbreviations,
  fromEnglishLayout,
  isFiller,
} from "./clarity";

describe("раскладка", () => {
  it("«ghbyznf» — «Принята»", () => {
    expect(fromEnglishLayout("ghbyznf")).toBe("Принята");
    expect(commentClarity("ghbyznf", "accepted")).toEqual({
      kind: "fix",
      text: "Возможно, вы имели в виду: «Принята»",
      suggestion: "Принята",
    });
  });
  it("знаки на клавишах букв внутри слова — буквы, в конце — знаки", () => {
    expect(fromEnglishLayout("ghbdtlty. ,hbuflf")).toBe("Приведен. бригада");
    expect(fromEnglishLayout("ghbyznf.")).toBe("Принята.");
  });
  it("несколько слов и цифры", () => {
    expect(fromEnglishLayout("ghbyznf 2 ,hbufls")).toBe("Принята 2 бригады");
  });
  it("русский текст, смесь и случайные буквы не трогаем", () => {
    expect(fromEnglishLayout("принята")).toBeNull();
    expect(fromEnglishLayout("принята ghbyznf")).toBeNull();
    expect(fromEnglishLayout("ok")).toBeNull();
    expect(fromEnglishLayout("xcvn")).toBeNull();
    expect(fromEnglishLayout("gggg")).toBeNull();
  });
});

describe("сокращения", () => {
  it("«отпр бр» — «Отправлена бригада»", () => {
    expect(expandAbbreviations("отпр бр")).toBe("Отправлена бригада");
    expect(commentClarity("отпр бр", "accepted")?.text).toBe(
      "Возможно, вы имели в виду: «Отправлена бригада»",
    );
  });
  it("точка и знаки сохраняются, регистр не важен", () => {
    expect(expandAbbreviations("Отпр. бр., выех")).toBe(
      "Отправлена. бригада., выехала",
    );
    expect(expandAbbreviations("отпр бр, пострадавших нет")).toBe(
      "Отправлена бригада, пострадавших нет",
    );
  });
  it("полные слова не трогаем", () => {
    expect(expandAbbreviations("отправлена бригада")).toBeNull();
    expect(commentClarity("Отправлена бригада 102, пострадавших нет", "")).toBe(
      null,
    );
  });
  it.each([
    "Бригада перед домом, проход свободен",
    "Перед входом нет пострадавших",
    "Заявитель сказал: раб",
  ])("не исправляет обычные слова: %s", (text) => {
    expect(expandAbbreviations(text)).toBeNull();
    expect(commentClarity(text, "accepted")).toBeNull();
  });
  it("в таблице только строчные ключи", () => {
    for (const key of Object.keys(ABBREVIATIONS))
      expect(key).toBe(key.toLowerCase());
  });
});

describe("«ок»", () => {
  it("пустые слова", () => {
    for (const text of ["ок", "ОК", "ok", "да, норм", "+", "Ок."])
      expect(isFiller(text), text).toBe(true);
    expect(isFiller("ок, бригада выехала")).toBe(false);
    expect(isFiller("")).toBe(false);
  });
  it("говорит, что написать, по статусу", () => {
    const hint = commentClarity("ок", "accepted");
    expect(hint?.kind).toBe("short");
    expect(hint?.suggestion).toBeNull();
    expect(hint?.text).toContain("«ок»");
    expect(hint?.text).toContain("что случилось, есть ли пострадавшие");
  });
  it("без статуса — без «Напишите»", () => {
    expect(commentClarity("ок", "")?.text).not.toContain("Напишите");
  });
});

describe("тишина", () => {
  it("пустой и понятный комментарий — без подсказки", () => {
    expect(commentClarity("", "accepted")).toBeNull();
    expect(commentClarity("   ", "accepted")).toBeNull();
    expect(
      commentClarity(
        "Пожар в квартире, пострадавших нет, направлена 101",
        "accepted",
      ),
    ).toBeNull();
  });
});
