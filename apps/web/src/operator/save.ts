// «сохранить»: отправка карточки на оценку (contracts/operator/evaluation.md) и список
// прошлых попыток.

import { csrfToken } from "../shared/api";
import type { Address } from "./model";
import type { CallerState } from "./dialog";
import type { CallJournal } from "./journal";
import { phoneValue } from "./phone";

export interface CardInput {
  readonly incident_type_code: string | null;
  readonly tags: readonly string[];
  readonly services: readonly string[];
  readonly address: {
    readonly city: string;
    readonly okrug: string;
    readonly district: string;
    readonly street: string;
    readonly house: string;
    readonly building: string;
    readonly apartment: string;
    readonly object: string;
    readonly structure: string;
    readonly entrance: string;
    readonly floor: string;
    readonly code: string;
    readonly descriptive: string;
  };
  readonly description: string;
  readonly caller_name: string;
  readonly caller_status: string;
  readonly phone_provided: string;
  readonly phone_scene: string;
  readonly off_site: boolean;
  readonly emergency?: boolean;
}

export interface Criterion {
  readonly key: string;
  readonly title: string;
  readonly weight: number;
  readonly score: number;
  readonly points: number;
  readonly explanation: string;
}

export interface AttemptSummary {
  readonly id: string;
  readonly scenario_id: string;
  readonly scenario_title: string;
  readonly created_at: string;
  readonly total: number;
  readonly max_total: number;
  readonly actor_id?: string;
  readonly actor_login?: string;
  readonly actor_name?: string;
}

export interface AttemptResult extends AttemptSummary {
  readonly criteria: readonly Criterion[];
  readonly operator_card: CardInput | null;
  /** Журнал звонка для разбора (этап 3); у попыток до этапа 3 — пустой. */
  readonly journal: CallJournal;
}

/** Карточка веба (Address, теги, службы) → тело запроса `/api/operator/save`. */
export function cardInput(params: {
  incidentTypeCode: string | null;
  tags: ReadonlySet<string>;
  services: readonly string[];
  address: Address;
  description: string;
  callerName: string;
  callerStatus: string;
  phoneProvided: string;
  phoneScene: string;
  offSite: boolean;
}): CardInput {
  return {
    incident_type_code: params.incidentTypeCode,
    tags: [...params.tags],
    services: params.services,
    address: {
      city: params.address.subject,
      okrug: params.address.okrug,
      district: params.address.district,
      street: params.address.street,
      house: params.address.house,
      building: params.address.korpus,
      apartment: params.address.apartment,
      object: params.address.object,
      structure: params.address.structure,
      entrance: params.address.entrance,
      floor: params.address.floor,
      code: params.address.code,
      descriptive: params.address.descriptive,
    },
    description: params.description,
    caller_name: params.callerName,
    caller_status: params.callerStatus,
    phone_provided: phoneValue(params.phoneProvided),
    phone_scene: phoneValue(params.phoneScene),
    off_site: params.offSite,
  };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken(),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (await response.json()) as T;
}

export async function saveAttempt(
  scenarioId: string,
  state: CallerState,
  elapsedS: number,
  card: CardInput,
  journal: CallJournal,
): Promise<AttemptResult> {
  return postJson<AttemptResult>("/api/operator/save", {
    scenario_id: scenarioId,
    state,
    elapsed_s: elapsedS,
    card,
    journal,
  });
}

export async function fetchAttempts(): Promise<AttemptSummary[]> {
  const response = await fetch("/api/operator/attempts", {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`attempts: ${response.status}`);
  return (await response.json()) as AttemptSummary[];
}

/** Одна попытка целиком — критерии и журнал звонка для экрана результатов 112. */
export async function fetchAttempt(id: string): Promise<AttemptResult> {
  const response = await fetch(
    `/api/operator/attempts/${encodeURIComponent(id)}`,
    { credentials: "include" },
  );
  if (!response.ok) throw new Error(`attempt: ${response.status}`);
  return (await response.json()) as AttemptResult;
}
