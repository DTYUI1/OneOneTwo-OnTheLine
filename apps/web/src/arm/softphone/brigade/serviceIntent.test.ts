import { describe, expect, it } from "vitest";

import type { AwaitedService } from "./logic";
import {
  calledService,
  newsService,
  phraseKind,
  saysCalled,
} from "./voiceReply";

const open: AwaitedService = {
  service: "103",
  open: true,
  asked: ["103"],
  opened: ["103"],
  called: ["103"],
};

describe("Смысл сообщения бригаде о вызванной службе", () => {
  it.each([
    ["Пожарную охрану уже вызвали", "101"],
    ["Сотрудников полиции направили", "102"],
    ["Вызванная скорая помощь", "103"],
    ["Медицинская бригада уже в пути", "103"],
    ["Газовую аварийную службу вызвали", "104"],
    ["Слесари уже выехали", "GKH"],
    ["Лифтовые механики направлены", "MOSLIFT"],
    ["Не пожарных, скорую вызвал", "103"],
    ["Полицию не вызвал, скорую вызвал", "103"],
  ])("понимает форму и адресата: %s", (text, service) => {
    expect(calledService(text)).toBe(service);
    expect(saysCalled(text)).toBe(true);
  });

  it.each([
    "Скорую уже вызвали?",
    "Когда приедет скорая?",
    "Уточните, скорую уже вызвали",
    "Нужно вызвать скорую",
    "Не удалось вызвать скорую",
    "Я пока не вызывал скорую",
    "Сейчас вызову скорую",
    "Вызванная скорая помощь не приедет",
  ])("не превращает вопрос, отрицание или намерение в факт: %s", (text) => {
    expect(saysCalled(text)).toBe(false);
    expect(calledService(text)).toBeNull();
    expect(newsService(text, open)).toBeNull();
  });

  it.each([
    "Медики уже едут",
    "Вызов приняли, машина в пути",
    "Да, уже вызвали",
  ])("использует однозначный контекст просьбы: %s", (text) => {
    expect(newsService(text, open)).toBe("103");
    expect(phraseKind(text, open)).toBe("service_called");
  });

  it("не подменяет названную службу ожидаемой", () => {
    expect(newsService("Полицию уже вызвал, едут", open)).toBeNull();
  });

  it("сохраняет проверку фактического вызова и срока", () => {
    const noCall = { ...open, open: false, opened: [], called: [] };
    const late = { ...open, open: false, opened: [] };
    expect(newsService("Медики уже едут", noCall)).toBeNull();
    expect(newsService("Медики уже едут", late)).toBeNull();
    expect(phraseKind("Медики уже едут", noCall)).toBe("info");
  });

  it("учитывает поправку, а не наличие подходящего слова где угодно", () => {
    expect(newsService("Скорую вызвал, нет, ещё не вызвал", open)).toBeNull();
    expect(newsService("Скорую ещё не вызвал, нет, уже вызвал", open)).toBe(
      "103",
    );
  });
});

describe("Строгая маршрутизация без потери нескольких адресатов", () => {
  it("выбирает допустимую службу, а не первый глобальный положительный факт", () => {
    expect(newsService("Пожарные и скорая уже едут", open)).toBe("103");
  });

  it("не выбирает адресата общей вести среди нескольких просьб", () => {
    expect(
      newsService("Уже вызвал", {
        ...open,
        asked: ["101", "103"],
        opened: ["101", "103"],
        called: ["101", "103"],
      }),
    ).toBeNull();
  });

  it("нормализует идентичность справочника, сохраняя проверку вызова", () => {
    expect(
      newsService("Слесари выехали", {
        service: "GKH",
        open: true,
        asked: ["GKH"],
        opened: ["GKH"],
        called: ["105"],
      }),
    ).toBe("GKH");
    expect(
      newsService("Лифтовые механики направлены", {
        service: "MOSLIFT",
        open: false,
        asked: ["MOSLIFT"],
        opened: [],
        called: ["106"],
      }),
    ).toBeNull();
  });
});
