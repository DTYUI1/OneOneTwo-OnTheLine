import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DispatcherStatus } from "../cardModel";
import { heardStatus, namedStatus, type HeardMessage } from "./heard";

const BANK = join(process.cwd(), "../../scripts/voices/bank/phrases");
// Место фразы в разговоре (README банка, «Места») → докуда дошла бригада: фраза может назвать
// статус этого этапа или прежнего («Прибыли, а там пусто» — прибытие в докладе об отказе).
const RANK: Partial<Record<DispatcherStatus, number>> = {
  responding: 1,
  arrived: 2,
  working: 3,
  completed: 4,
  refused: 4,
};
const SLOT_RANK: Record<string, number> = {
  responding: 1,
  enroute: 1,
  delay: 1,
  arrived: 2,
  wrong_place: 2,
  working: 3,
  status_working: 3,
  update: 3,
  completed: 4,
  refused: 4,
};

function said(text: string, at: string, state = "presented"): HeardMessage {
  return { state, presented_at: at, delivery: { message: { text } } };
}

describe("«Услышано по телефону»: статус, названный старшим", () => {
  it("называет статус прямыми словами", () => {
    expect(namedStatus("Работы закончили, наряд освободился.")).toBe(
      "completed",
    );
    expect(namedStatus("Диспетчер, работы завершены. Возвращаемся.")).toBe(
      "completed",
    );
    expect(namedStatus("Всё, закончили. Сворачиваемся.")).toBe("completed");
    expect(namedStatus("Экипаж на месте. Выставили знак.")).toBe("arrived");
    expect(namedStatus("Прибыли. Дым из окна.")).toBe("arrived");
    expect(namedStatus("Вызов принят, отделение выехало.")).toBe("responding");
    expect(namedStatus("Приняла, бригада выехала.")).toBe("responding");
    expect(namedStatus("Понял, едем.")).toBeNull();
  });

  it("обстановку в статус не переводит: решает обучаемый", () => {
    expect(
      namedStatus("Машин на месте нет, участники разъехались до нас."),
    ).toBeNull();
    expect(
      namedStatus("Машин уже нет, участники уехали. Работ не было."),
    ).toBeNull();
    expect(namedStatus("Работаем на месте, доложу по итогу.")).toBeNull();
  });

  it("в банке фраза называет только статус своего этапа или прежнего", () => {
    const wrong: string[] = [];
    let named = 0;
    for (const file of readdirSync(BANK)) {
      const book = JSON.parse(readFileSync(join(BANK, file), "utf-8")) as {
        phrases: { id: string; slot: string; text: string }[];
      };
      for (const phrase of book.phrases) {
        const status = namedStatus(phrase.text);
        if (!status) continue;
        named += 1;
        if ((RANK[status] ?? 9) > (SLOT_RANK[phrase.slot] ?? 0))
          wrong.push(`${phrase.id}: ${status} — «${phrase.text}»`);
      }
    }
    expect(wrong).toEqual([]);
    expect(named).toBeGreaterThan(20);
  });

  it("доклад сценария называет не дальше статуса, который он обосновывает", () => {
    const dir = join(process.cwd(), "../../data/scenarios");
    const wrong: string[] = [];
    for (const file of readdirSync(dir).filter((name) =>
      name.endsWith(".json"),
    )) {
      const data = JSON.parse(readFileSync(join(dir, file), "utf-8")) as {
        plan: {
          key: string;
          justifies_state: DispatcherStatus;
          line: string | { text: string };
        }[];
      };
      for (const report of data.plan) {
        const text =
          typeof report.line === "string" ? report.line : report.line.text;
        const status = namedStatus(text);
        if (status && (RANK[status] ?? 9) > (RANK[report.justifies_state] ?? 0))
          wrong.push(`${file} ${report.key}: ${status} — «${text}»`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("берёт последнюю прозвучавшую реплику и только доступный статус", () => {
    const messages = [
      said(
        "Экипаж на месте. Машины стоят в крайнем ряду.",
        "2026-10-17T10:00:10Z",
      ),
      said("Работы закончили, наряд освободился.", "2026-10-17T10:01:00Z"),
      said("Прибыли.", "2026-10-17T10:02:00Z", "delivered"),
    ];
    const all: DispatcherStatus[] = ["working", "completed", "refused"];
    expect(heardStatus(messages, all, "")).toBe("completed");
    // Уже выбран в строке статуса — подставлять нечего.
    expect(heardStatus(messages, all, "completed")).toBeNull();
    // Статус сейчас не поставить (карточка дальше или закрыта) — строки нет.
    expect(heardStatus(messages, ["refused"], "")).toBeNull();
    expect(heardStatus([], all, "")).toBeNull();
  });
});
