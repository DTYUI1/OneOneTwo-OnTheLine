// Вводная бригаде (GP-05, docs/dds_gameplay.md, разделы 3 и 4): бригада выезжает только
// после разговора с диспетчером — адрес и что случилось, голосом или по частям. Что поймёт
// бригада, решает сервер (`POST /calls/{id}/briefing-check`, одно правило для голоса и
// частей); здесь — шаги по частям и что бригада говорит в ответ. Без React и сети.

import type { components } from "../../../api-client/schema";
import type { Card } from "../../../shared/api";
import { addressOptions, incidentOptions, type PartStep } from "../parts";
import { notUnderstood } from "./voiceReply";

export type BriefingCheck = components["schemas"]["BriefingCheck"];

export type BriefingStep = PartStep<"address" | "what">;

/**
 * Шаги вводной по частям (GP-06): на шаге до трёх коротких вариантов — верный из карточки
 * и похожие ошибки. Верна ли часть, решает сервер по склеенной фразе, как у голоса:
 * «Бубнинская, 124» — бригада поедет туда.
 */
export function briefingSteps(
  source: Pick<Card["source"], "address" | "incident_class" | "description">,
  seed: string,
): readonly BriefingStep[] {
  return [
    {
      key: "address",
      label: "Адрес",
      options: addressOptions(source.address, seed),
    },
    {
      key: "what",
      label: "Что случилось",
      options: incidentOptions(
        source.incident_class || source.description,
        seed,
      ),
    },
  ];
}

/** Части склеиваются в одну фразу: сервер проверяет её тем же правилом, что голос. */
export function briefingText(parts: readonly string[]): string {
  return parts.map((part) => part.trim().replace(/\.$/, "")).join(". ");
}

/** Бригада ждёт вводной: идёт разговор с ней, решение принято, она ещё не выехала. */
export function needsBriefing(input: {
  readonly brigadeId: string | null;
  readonly decided: boolean;
  readonly refusal: boolean;
  readonly dispatched: readonly string[];
}): boolean {
  return (
    input.brigadeId !== null &&
    input.decided &&
    !input.refusal &&
    !input.dispatched.includes(input.brigadeId)
  );
}

/**
 * Что бригада отвечает на вводную: переспрашивает недостающее или повторяет адрес
 * («Повторяю: …»). `null` — повторит адрес ловушка сценария, после доклада о выезде. Проверки
 * нет (сервер не ответил) — «Не понял, повторите» из банка службы (GP-25); переспрос
 * недостающего и повтор адреса пишет сервер (`ask_again`, `readback`): в них адрес и
 * содержание вводной, фраз банка под них нет.
 */
export function briefingAnswer(
  check: BriefingCheck | null,
  service: string | null | undefined,
): string | null {
  if (check === null) return notUnderstood(service);
  if (!check.complete) return check.ask_again ?? notUnderstood(service);
  return check.readback;
}
