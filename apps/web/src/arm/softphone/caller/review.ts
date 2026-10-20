// «Работа с заявителем» в разборе (HQ-019, docs/dds_caller.md, раздел 5, пп. 5–7): по
// отметкам `caller_said` журнала карточки — паузы диспетчера («Алло, вы тут?»), отбой
// заявителя по тишине, выяснил ли диспетчер, когда заявитель подойдёт, попросил ли подойти,
// повторы вопроса и поправленный адрес. Решение капитана 18.10: только строки разбора, на
// балл не влияют. Чистые функции.
import type { components } from "../../../api-client/schema";
import { bankPhrase } from "../bank";
import { factsOf } from "./book";

type StoredEvent = components["schemas"]["StoredEvent"];

/** Место фразы заявителя: `CALLER_CALM.no_reply.animal_shaft.1` → `no_reply`. */
function slotOf(phraseId: string): string {
  return phraseId.split(".")[1] ?? "";
}

function times(count: number): string {
  const tail = count % 10;
  const teen = count % 100 >= 11 && count % 100 <= 14;
  return `${count} ${!teen && tail >= 2 && tail <= 4 ? "раза" : "раз"}`;
}

/** Строки разбора; `null` — заявителю не звонили (реплик заявителя в журнале нет). */
export function callerReview(
  events: readonly StoredEvent[],
): readonly string[] | null {
  const said = [...events]
    .filter((event) => event.type === "caller_said")
    .sort((a, b) => Date.parse(a.server_ts) - Date.parse(b.server_ts))
    .map((event) => String(event.payload.phrase_id ?? ""));
  if (said.length === 0) return null;
  const count = (slot: string) =>
    said.filter((id) => slotOf(id) === slot).length;
  const eta = said.some((id) => {
    const phrase = bankPhrase(id);
    return (
      slotOf(id) === "tell_eta" &&
      phrase !== null &&
      factsOf(phrase).includes("eta")
    );
  });
  const agreed = count("agree") > 0;
  const dropped = count("hangup");
  const lines: string[] = [];
  if (eta && agreed)
    lines.push(
      "Выяснили, когда заявитель подойдёт, и попросили подойти к бригаде.",
    );
  else if (eta)
    lines.push(
      "Выяснили, когда заявитель подойдёт, но не попросили подойти к бригаде.",
    );
  else if (dropped > 0)
    lines.push(
      "Не выяснили, когда заявитель подойдёт: заявитель положил трубку.",
    );
  else lines.push("Не выяснили, когда заявитель подойдёт.");
  if (!eta && agreed) lines.push("Попросили заявителя подойти к бригаде.");
  if (!agreed && !eta) lines.push("Не попросили заявителя подойти к бригаде.");
  const pauses = count("no_reply");
  if (pauses > 0)
    lines.push(
      `Пауза — заявитель переспросил «Алло, вы тут?»: ${times(pauses)}.`,
    );
  if (dropped > 0)
    lines.push(`Заявитель положил трубку, не дождавшись: ${times(dropped)}.`);
  const repeats = count("repeat");
  if (repeats > 0) lines.push(`Повтор вопроса: ${times(repeats)}.`);
  if (count("correct_address") > 0)
    lines.push("Адрес прочитан с ошибкой, заявитель поправил.");
  return lines;
}
