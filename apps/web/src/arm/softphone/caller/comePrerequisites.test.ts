import { expect, it } from "vitest";
import { callerBook } from "./book";
import { freshMemory, reply, pickUp, hungUp } from "./conversation";
import { hear } from "./hearing";
import { callerGuidance, callerChoices } from "./questions";

it.each(["pipe_access", "lift_location"])(
  "%s: просьба подойти ждёт полных сведений",
  (plot) => {
    for (const character of ["calm", "confused"] as const) {
      const book = callerBook(character, plot)!;
      let memory = { ...freshMemory, service: true, reason: true };
      const say = (text: string) => {
        const turn = reply(book, memory, hear(text, book.story), {
          house: "22",
          flat: "58",
        });
        memory = turn.memory;
        return turn;
      };
      const choices = () =>
        callerChoices({
          book,
          memory,
          serviceName: "ЖКХ",
          street: "Улица",
          house: "22",
          flat: "58",
          seed: "test",
        });
      expect(say(book.story.come).lines).toEqual([]);
      expect(memory.came).toBe(false);
      expect(choices().map((q) => q.id)).not.toContain("come");
      const required =
        plot === "pipe_access" ? ["where", "eta", "box"] : ["where", "box"];
      for (const fact of required) {
        expect(choices().map((q) => q.id)).toContain(fact);
        const question = book.story.facts.find((f) => f.fact === fact)!.ask;
        say(question);
        if (memory.facts[fact] !== "full") {
          expect(say(book.story.come).lines).toEqual([]);
          expect(choices().map((q) => q.id)).toContain(fact);
          say(question);
        }
      }
      expect(memory.came).toBe(false);
      expect(choices().map((q) => q.id)).toContain("come");
      expect(say(book.story.come).lines[0]?.id).toContain(".agree.");
      expect(memory.came).toBe(true);
      expect(say("До свидания").lines[0]?.id).toContain(".end_call.");
      memory = { ...freshMemory, service: true, reason: true };
      const bye = say("До свидания");
      expect(bye.hangup).toBe(true);
      expect(bye.lines).toEqual([]);
      memory = pickUp(book, hungUp(memory, true)).memory;
      expect(say(book.story.come).lines).toEqual([]);
      expect(say("Повторите").lines.some((p) => p.id.includes(".agree."))).toBe(
        false,
      );
    }
  },
);

it("подсказка описывает следующие действия, не выдаёт согласие за доступ", () => {
  const book = callerBook("calm", "pipe_access")!;
  expect(callerGuidance(book, freshMemory)).toContain("Где вы ждёте бригаду?");
  const complete = {
    ...freshMemory,
    facts: { where: "full", eta: "full", box: "full" } as const,
  };
  expect(callerGuidance(book, complete)).toContain(book.story.come);
  expect(callerGuidance(book, { ...complete, came: true })).toContain(
    "По частям",
  );
  expect(
    callerGuidance(callerBook("calm", "animal_shaft")!, freshMemory),
  ).toBeNull();
});

it.each(["pipe_access", "lift_location"])(
  "%s: последний факт и просьба в одной фразе обрабатываются по порядку",
  (plot) => {
    const book = callerBook("calm", plot)!;
    const memory = {
      ...freshMemory,
      service: true,
      reason: true,
      facts: { where: "full", eta: "full" } as const,
    };
    const box = book.story.facts.find((item) => item.fact === "box")!.ask;
    const before = reply(
      book,
      memory,
      hear(`${book.story.come} ${box}`, book.story),
      { house: "22", flat: "58" },
    );
    expect(before.memory.came).toBe(false);
    expect(before.lines.some((line) => line.id.includes(".agree."))).toBe(
      false,
    );
    const after = reply(
      book,
      memory,
      hear(`${box} ${book.story.come}`, book.story),
      { house: "22", flat: "58" },
    );
    expect(after.memory.came).toBe(true);
    expect(after.lines.at(-1)?.id).toContain(".agree.");
  },
);
