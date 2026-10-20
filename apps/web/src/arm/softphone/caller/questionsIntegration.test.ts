import { expect, it } from "vitest";
import { callerBook } from "./book";
import { freshMemory } from "./conversation";
import {
  callerChoices,
  callerQuestions,
  MAX_QUESTIONS,
  SPARE_QUESTIONS,
} from "./questions";

it.each(["", "58"])(
  "короткий список сохраняет перемешивание и верный адрес с квартирой «%s»",
  (flat) => {
    const book = callerBook("calm", "animal_shaft");
    if (!book) throw new Error("Нет книги заявителя");
    const memory = {
      ...freshMemory,
      service: true,
      came: true,
      facts: { where: "full", eta: "full", address: "full" } as const,
    };
    const orders = Array.from({ length: 20 }, (_, index) => {
      const input = {
        book,
        serviceName: "ЖКХ",
        street: "Кировоградская улица",
        house: "22",
        flat,
        seed: `call-${index}`,
        memory,
      };
      const all = callerQuestions(input);
      const choices = callerChoices(input);
      expect(callerChoices(input)).toEqual(choices);
      expect(choices.length).toBeLessThanOrEqual(MAX_QUESTIONS);
      expect(choices.at(-1)?.id).toBe("bye");
      const address = choices.filter((item) => item.id.startsWith("readback:"));
      expect(address).toHaveLength(2);
      expect(address.filter((item) => item.correct)).toHaveLength(1);
      expect(address.find((item) => item.correct)?.text).toBe(
        `Кировоградская улица, 22${flat ? `, кв. ${flat}` : ""}, верно?`,
      );
      // Фильтрация короткого списка не меняет порядок полного списка.
      expect(address).toEqual(
        all.filter((item) => address.some((q) => q.id === item.id)),
      );
      const spare = choices.filter((item) =>
        book.story.facts.some(({ fact }) => fact === item.id),
      );
      expect(spare).toHaveLength(SPARE_QUESTIONS);
      expect(
        callerChoices({ ...input, memory: freshMemory }).some((item) =>
          item.id.startsWith("readback:"),
        ),
      ).toBe(false);
      expect(
        callerChoices({ ...input, memory: { ...memory, readback: true } }).some(
          (item) => item.id.startsWith("readback:"),
        ),
      ).toBe(false);
      return address.findIndex((item) => item.correct);
    });
    expect(new Set(orders).size).toBeGreaterThan(1);
  },
);
