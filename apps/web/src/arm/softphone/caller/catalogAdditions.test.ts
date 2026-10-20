import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { callerAudio, callerBook, factsOf } from "./book";
import { freshMemory, pickUp, reply } from "./conversation";
import { hear } from "./hearing";
import { callerChoices, callerQuestions } from "./questions";
import { BANK_BOOKS, bankText } from "../bank";

interface SourcePhrase {
  id: string;
  text: string;
  slot: string;
  incidents: string[];
}

function sourceBook(id: string): {
  phrases: SourcePhrase[];
  plot_facts_by_plot: Record<string, { address: string }>;
} {
  return JSON.parse(
    readFileSync(`../../scripts/voices/bank/callers/${id}.json`, "utf8"),
  );
}

const plots = [
  {
    plot: "pipe_access",
    street: "улица Пришвина",
    house: "17",
    keys: ["where", "eta", "box"],
  },
  {
    plot: "lift_location",
    street: "Профсоюзная улица",
    house: "98",
    keys: ["where", "box"],
  },
] as const;

for (const setup of plots) {
  describe(setup.plot, () => {
    it.each(["calm", "confused"] as const)(
      "%s: real questions, clarification and recorded plot facts",
      (character) => {
        const book = callerBook(character, setup.plot);
        expect(book).not.toBeNull();
        if (!book) throw new Error(`Missing caller book: ${setup.plot}`);
        const source = sourceBook(book.id);
        const sourceIds = new Map(
          source.phrases.map((line) => [line.id, line]),
        );
        const exported = Object.values(BANK_BOOKS[book.id].slots).flatMap(
          (lines) => lines ?? [],
        );
        expect(exported.map((line) => line.id).sort()).toEqual(
          source.phrases.map((line) => line.id).sort(),
        );
        for (const line of exported) {
          const original = sourceIds.get(line.id)!;
          expect(line.text, line.id).toBe(original.text);
          expect(callerAudio(line), line.id).not.toBeNull();
        }
        const input = {
          book,
          street: setup.street,
          house: setup.house,
          flat: "",
          serviceName: "ДДС",
          seed: "catalog-addition",
        };
        const picked = pickUp(book, freshMemory);
        expect(picked.lines.length).toBeGreaterThan(0);
        expect(picked.memory.facts).toEqual({});
        expect(picked.lines.flatMap(factsOf)).toEqual([]);
        for (const line of picked.lines) {
          expect(callerAudio(line)).not.toBeNull();
          expect(sourceIds.get(line.id)?.incidents).toContain(setup.plot);
        }
        let memory = picked.memory;
        for (const key of setup.keys) {
          expect(
            callerChoices({ ...input, memory }).some((item) => item.id === key),
          ).toBe(true);
        }
        memory = reply(
          book,
          memory,
          hear("Диспетчер, по вашей заявке.", book.story),
          { house: setup.house, flat: "" },
        ).memory;
        for (const option of callerQuestions(input)) {
          const heard = hear(option.text, book.story, setup.street);
          if (option.id === "intro") {
            expect(heard.service && heard.reason).toBe(true);
            continue;
          }
          if (option.id.startsWith("readback:")) {
            expect(heard.asks[0]?.kind).toBe("readback");
            continue;
          }
          if (option.id === "come" || option.id === "bye") {
            expect(heard.asks).toEqual([{ kind: option.id }]);
            continue;
          }
          expect(heard.asks).toEqual([{ kind: "fact", fact: option.id }]);
          let turn = reply(book, memory, heard, {
            house: setup.house,
            flat: "",
          });
          if (turn.memory.facts[option.id] === "first") {
            expect(turn.lines.flatMap(factsOf)).toEqual([]);
            for (const line of turn.lines) {
              expect(callerAudio(line)).not.toBeNull();
              expect(sourceIds.get(line.id)?.incidents).toContain(setup.plot);
            }
            expect(
              callerChoices({ ...input, memory: turn.memory }).some(
                (item) => item.id === option.id,
              ) || !setup.keys.some((key) => key === option.id),
            ).toBe(true);
            turn = reply(book, turn.memory, heard, {
              house: setup.house,
              flat: "",
            });
          }
          expect(turn.lines.flatMap(factsOf)).toContain(option.id);
          for (const line of turn.lines) {
            expect(callerAudio(line)).toBeTruthy();
            expect(callerAudio(line)).toContain(`/bank/${line.id}.ogg`);
            expect(bankText(line.id)).toBe(line.text);
            expect(sourceIds.get(line.id)?.incidents).toContain(setup.plot);
            if (factsOf(line).length > 0) {
              expect(sourceIds.get(line.id)?.incidents).toEqual([setup.plot]);
            }
            expect(line.only?.split(",")).toContain(setup.plot);
            expect(line.text).not.toMatch(/котён|Кировоград/);
          }
          memory = turn.memory;
        }
        for (const key of setup.keys) {
          expect(memory.facts[key]).toBe("full");
          expect(
            callerChoices({ ...input, memory }).some((item) => item.id === key),
          ).toBe(false);
        }
      },
    );
  });
}

for (const setup of plots)
  describe(`${setup.plot} full address readback`, () => {
    it.each(["calm", "confused"] as const)(
      "%s confirms the configured full address",
      (character) => {
        const book = callerBook(character, setup.plot)!;
        const input = {
          book,
          street: setup.street,
          house: setup.house,
          flat: "",
          serviceName: "ДДС",
          seed: "readback",
        };
        const facts = sourceBook(book.id).plot_facts_by_plot[setup.plot];
        const text = `${facts.address.split(".")[0]}, верно?`;
        const memory = reply(
          book,
          freshMemory,
          hear("Диспетчер, по вашей заявке.", book.story),
          { house: setup.house, flat: "" },
        ).memory;
        const turn = reply(book, memory, hear(text, book.story, input.street), {
          house: setup.house,
          flat: "",
        });
        expect(turn.lines).toHaveLength(1);
        expect(turn.lines[0]?.id).toContain(".confirm_address.");
        expect(callerAudio(turn.lines[0]!)).toContain(
          `/bank/${turn.lines[0]!.id}.ogg`,
        );
        expect(factsOf(turn.lines[0]!)).toContain("address");
        expect(turn.lines[0]?.text).not.toMatch(
          /Номер квартиры здесь не нужен|корпус/,
        );
      },
    );
  });
