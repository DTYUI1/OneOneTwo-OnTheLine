// Студия сценариев (D-01): форма вместо JSON. Чистая логика без React и сети —
// перевод формы в Scenario и обратно, проверки у своих полей, эталон словами.
import type { components } from "../../api-client/schema";

export type Scenario = components["schemas"]["Scenario"];
export type IncidentType = components["schemas"]["IncidentType"];
export type Service = components["schemas"]["Service"];
type Address = Scenario["card"]["address"];
export type Complication = Scenario["complications"][number];
type FlowState =
  | "added"
  | "received"
  | "accepted"
  | "rejected"
  | "responding"
  | "refused"
  | "completed"
  | "redirected";

/**
 * Служба классификатора → служба MVP. Соответствие закреплено в
 * contracts/data_formats.md; для остальных кодов службы среди шести нет —
 * преподаватель выбирает сам, выдуманных ID не подставляем.
 */
export const CLASSIFIER_SERVICE: Record<string, string> = {
  MCHS: "101",
  Police: "102",
  AMBULANCE: "103",
  MOSGAZ: "104",
  GKH: "GKH",
  MOSLIFT: "MOSLIFT",
};

export const ORIGIN_LABELS: Record<Scenario["origin"], string> = {
  template: "шаблон",
  llm: "сгенерирован ИИ",
  imported: "импорт",
  trainee: "от обучаемого",
};

export const STATUS_LABELS: Record<Scenario["status"], string> = {
  draft: "черновик",
  approved: "утверждён",
  retired: "в архиве",
};

export const COMPLICATION_LABELS: Record<Complication, string> = {
  wrong_address: "неверный адрес",
  duplicate: "повторный вызов",
  no_phone: "нет телефона",
  no_contact: "нет связи с заявителем",
  emergency: "признаки ЧС",
  parallel: "параллельные карточки",
};

/** Чем должна кончиться карточка по эталону — переходы как в validation.py. */
export type Outcome =
  | "complete"
  | "accept_refuse"
  | "respond_refuse"
  | "reject"
  | "redirect";

export const OUTCOME_FLOWS: Record<Outcome, FlowState[]> = {
  complete: ["received", "accepted", "responding", "completed"],
  accept_refuse: ["received", "accepted", "refused"],
  respond_refuse: ["received", "accepted", "responding", "refused"],
  reject: ["received", "rejected"],
  redirect: ["received", "rejected", "redirected"],
};

export const OUTCOME_LABELS: Record<Outcome, string> = {
  complete: "принять и довести до «Работы завершены»",
  accept_refuse: "принять, затем отказ от выполнения работ",
  respond_refuse: "начать реагирование, затем отказ",
  reject: "не принимать",
  redirect: "не принимать и перенаправить",
};

export type RequiredField = "service_number" | "comment";
export const REQUIRED_FIELD_LABELS: Record<RequiredField, string> = {
  service_number: "номер в службе",
  comment: "комментарий",
};

/** Плоская модель формы: у каждого поля своё место для ошибки. */
export interface ScenarioForm {
  id: string;
  version: number;
  status: Scenario["status"];
  origin: Scenario["origin"];
  level: number;
  weight: number;
  incidentTypeCode: string;
  incidentClass: string;
  targetServiceId: string;
  number: string;
  callerName: string;
  phoneAon: string;
  phoneProvided: string;
  phoneScene: string;
  address: Address;
  description: string;
  tags: string;
  victims: boolean;
  ambulanceRefused: boolean;
  blockedPeople: boolean;
  emergency: boolean;
  complications: Complication[];
  outcome: Outcome;
  expectedServiceIds: string[];
  callRequired: boolean;
  callServiceId: string;
  callBeforeS: number;
  requiredFields: RequiredField[];
  addressAsCard: boolean;
  expectedAddress: Address;
  expectedComment: string;
  /** Ключевые слова комментария через запятую; варианты пункта — через «/». */
  commentKeywords: string;
  teacherComment: string;
}

export const EMPTY_ADDRESS: Address = {
  city: "Москва",
  okrug: "",
  district: "",
  street: "",
  house: "",
  building: "",
  apartment: "",
};

/** Новый черновик. Номер карточки — восьмизначный, как в реестре ДДС. */
export function emptyForm(id: string, number: string): ScenarioForm {
  return {
    id,
    version: 1,
    status: "draft",
    origin: "template",
    level: 1,
    weight: 1,
    incidentTypeCode: "",
    incidentClass: "",
    targetServiceId: "",
    number,
    callerName: "",
    phoneAon: "",
    phoneProvided: "",
    phoneScene: "",
    address: { ...EMPTY_ADDRESS },
    description: "",
    tags: "",
    victims: false,
    ambulanceRefused: false,
    blockedPeople: false,
    emergency: false,
    complications: [],
    outcome: "complete",
    expectedServiceIds: [],
    callRequired: true,
    callServiceId: "",
    callBeforeS: 180,
    requiredFields: ["service_number", "comment"],
    addressAsCard: true,
    expectedAddress: { ...EMPTY_ADDRESS },
    expectedComment: "",
    commentKeywords: "",
    teacherComment: "",
  };
}

/** Какой исход записан в эталоне; неизвестная последовательность — «довести до конца». */
export function outcomeOf(flow: string[]): Outcome {
  const states = flow[0] === "added" ? flow.slice(1) : flow;
  const found = (Object.keys(OUTCOME_FLOWS) as Outcome[]).find(
    (key) => OUTCOME_FLOWS[key].join() === states.join(),
  );
  return found ?? "complete";
}

type Reference = {
  expected_flow?: string[];
  required_fields?: RequiredField[];
  expected_service_ids?: string[];
  expected_call?: {
    required?: boolean;
    service_id?: string;
    phone_ext?: string;
    before_s?: number;
  };
  expected_address?: Address;
  expected_comment?: string;
  comment_keywords?: string[];
};

export function formFromScenario(scenario: Scenario): ScenarioForm {
  const reference = scenario.reference as Reference;
  const card = scenario.card;
  const expectedAddress = reference.expected_address ?? card.address;
  return {
    id: scenario.id,
    version: scenario.version,
    status: scenario.status,
    origin: scenario.origin,
    level: scenario.level,
    weight: scenario.weight,
    incidentTypeCode: scenario.incident_type_code,
    incidentClass: card.incident_class,
    targetServiceId: scenario.target_service_id,
    number: card.number,
    callerName: card.caller_name,
    phoneAon: card.phone_aon,
    phoneProvided: card.phone_provided,
    phoneScene: card.phone_scene,
    address: { ...EMPTY_ADDRESS, ...card.address },
    description: card.description,
    tags: card.tags.join(", "),
    victims: card.victims,
    ambulanceRefused: card.ambulance_refused,
    blockedPeople: card.blocked_people,
    emergency: card.emergency,
    complications: [...scenario.complications],
    outcome: outcomeOf(reference.expected_flow ?? []),
    expectedServiceIds: reference.expected_service_ids ?? [],
    callRequired: reference.expected_call?.required === true,
    callServiceId: reference.expected_call?.service_id ?? "",
    callBeforeS: reference.expected_call?.before_s ?? 180,
    requiredFields: reference.required_fields ?? [],
    addressAsCard: sameAddress(expectedAddress, card.address),
    expectedAddress: { ...EMPTY_ADDRESS, ...expectedAddress },
    expectedComment: reference.expected_comment ?? "",
    commentKeywords: (reference.comment_keywords ?? []).join(", "),
    teacherComment: scenario.teacher_comment,
  };
}

/** «утечка / запах газа, эвакуация» → ["утечка / запах газа", "эвакуация"]. */
export function keywordList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  ];
}

export function sameAddress(a: Address, b: Address): boolean {
  return (Object.keys(EMPTY_ADDRESS) as (keyof Address)[]).every(
    (key) => (a[key] ?? "") === (b[key] ?? ""),
  );
}

/** Форма → Scenario для POST/PUT. Службы карточки — адресат сценария. */
export function scenarioFromForm(
  form: ScenarioForm,
  services: Pick<Service, "id" | "phone_ext">[],
): Scenario {
  const phoneExt =
    services.find((service) => service.id === form.callServiceId)?.phone_ext ??
    "";
  const reference: Reference = {
    expected_flow: OUTCOME_FLOWS[form.outcome],
    required_fields: form.requiredFields,
    expected_service_ids: form.expectedServiceIds,
    expected_call: form.callRequired
      ? {
          required: true,
          service_id: form.callServiceId,
          phone_ext: phoneExt,
          before_s: form.callBeforeS,
        }
      : { required: false },
    expected_address: form.addressAsCard ? form.address : form.expectedAddress,
    expected_comment: form.expectedComment.trim(),
    // Пустой список не пишем: эталоны без своих слов остаются прежними.
    ...(keywordList(form.commentKeywords).length > 0
      ? { comment_keywords: keywordList(form.commentKeywords) }
      : {}),
  };
  return {
    id: form.id,
    version: form.version,
    level: form.level,
    weight: form.weight,
    incident_type_code: form.incidentTypeCode,
    target_service_id: form.targetServiceId,
    card: {
      number: form.number,
      incident_type_code: form.incidentTypeCode,
      incident_class: form.incidentClass,
      caller_name: form.callerName.trim(),
      phone_aon: form.phoneAon.trim(),
      phone_provided: form.phoneProvided.trim(),
      phone_scene: form.phoneScene.trim(),
      address: form.address,
      description: form.description.trim(),
      tags: form.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      victims: form.victims,
      ambulance_refused: form.ambulanceRefused,
      blocked_people: form.blockedPeople,
      emergency: form.emergency,
      service_ids: form.targetServiceId ? [form.targetServiceId] : [],
    } as Scenario["card"],
    reference: reference as Scenario["reference"],
    complications: form.complications,
    origin: form.origin,
    status: form.status,
    teacher_comment: form.teacherComment.trim(),
  };
}

/** Раздел формы, к которому привязана ошибка. */
export type FormSection =
  | "incident"
  | "card"
  | "address"
  | "reference"
  | "call"
  | "general";
export type FormErrors = Partial<Record<FormSection, string[]>>;

const PHONE = /^(\+7[0-9]{10})?$/;

/**
 * Проверка до отправки. Для черновика — только то, без чего сервер не примет
 * данные; для утверждения — ещё и пригодность эталона, как validate_reference
 * в evalcore: неполный эталон нельзя выдать обучаемому.
 */
export function validateForm(
  form: ScenarioForm,
  intent: "draft" | "approve",
): FormErrors {
  const errors: FormErrors = {};
  const add = (section: FormSection, message: string) =>
    (errors[section] ??= []).push(message);

  if (!form.incidentTypeCode)
    add("incident", "Выберите тип происшествия из классификатора.");
  if (!form.targetServiceId)
    add("incident", "Выберите службу, которой адресовано происшествие.");
  if (!Number.isInteger(form.level) || form.level < 1 || form.level > 4)
    add("incident", "Уровень — от 1 до 4.");
  if (!Number.isInteger(form.weight) || form.weight < 1 || form.weight > 10)
    add("incident", "Вес — целое от 1 до 10.");

  if (!/^[0-9]{8}$/.test(form.number))
    add("card", "Номер карточки — ровно 8 цифр.");
  for (const [label, value] of [
    ["АОН", form.phoneAon],
    ["предоставленный", form.phoneProvided],
    ["телефон на место", form.phoneScene],
  ] as const)
    if (!PHONE.test(value.trim()))
      add("card", `Телефон «${label}» — пусто или +7 и 10 цифр.`);

  if (intent === "approve") {
    if (!form.description.trim())
      add("card", "Опишите происшествие: его читает обучаемый.");
    if (!form.address.street.trim() || !form.address.house.trim())
      add("address", "Укажите улицу и дом: адрес сверяется при оценке.");
    if (form.outcome === "redirect" && form.expectedServiceIds.length === 0)
      add("reference", "Для перенаправления укажите службу-получателя.");
    if (form.callRequired && !form.callServiceId)
      add("call", "Для обязательного звонка укажите службу-получателя.");
    if (
      form.callRequired &&
      (!Number.isInteger(form.callBeforeS) || form.callBeforeS < 1)
    )
      add("call", "Срок звонка — целое число секунд.");
  }
  return errors;
}

export function hasErrors(errors: FormErrors): boolean {
  return Object.values(errors).some((list) => list && list.length > 0);
}

/**
 * Ошибку сервера — к её разделу формы (A2: «ошибки показываются у
 * соответствующих данных»). Незнакомый текст — в общий блок, как есть.
 */
export function sectionForServerError(message: string): FormSection {
  if (/эталон|Последовательность|перенаправлен/i.test(message))
    return "reference";
  if (/звонк/i.test(message)) return "call";
  if (/тип происшествия|служба/i.test(message)) return "incident";
  return "general";
}

/** 409 сервера — какой выход предложить. */
export function conflictKind(message: string): "assigned" | "stale" | "other" {
  if (/Назначенный сценарий/i.test(message)) return "assigned";
  if (/уже изменён|актуальную версию/i.test(message)) return "stale";
  return "other";
}

/** Копия как новый черновик: история назначений исходного сценария не трогается. */
export function copyForm(form: ScenarioForm, id: string): ScenarioForm {
  return { ...form, id, version: 1, status: "draft" };
}

/** Служба MVP для типа происшествия по классификатору, если она есть. */
export function serviceForType(
  type: Pick<IncidentType, "main_service_code">,
): string {
  return CLASSIFIER_SERVICE[type.main_service_code] ?? "";
}

/**
 * Ожидаемые действия словами — что предпросмотр показывает преподавателю
 * и что проверит оценщик.
 */
export function expectedActions(
  form: ScenarioForm,
  serviceName: (id: string) => string,
): string[] {
  const steps: string[] = [];
  const flow = OUTCOME_FLOWS[form.outcome];
  const minutes = (s: number) =>
    s % 60 === 0 ? `${s / 60} мин` : `${Math.floor(s / 60)} мин ${s % 60} с`;
  if (flow.includes("accepted")) steps.push("Принять карточку.");
  if (flow.includes("rejected")) steps.push("Не принимать карточку.");
  if (form.outcome === "redirect")
    steps.push(
      `Перенаправить: ${form.expectedServiceIds.map(serviceName).join(", ") || "служба не указана"}.`,
    );
  if (form.callRequired)
    steps.push(
      `Позвонить в ${serviceName(form.callServiceId) || "службу"} не позднее ${minutes(form.callBeforeS)} после появления карточки.`,
    );
  if (flow.includes("responding"))
    steps.push("Поставить «Начало реагирования».");
  if (form.requiredFields.length)
    steps.push(
      `Заполнить: ${form.requiredFields.map((field) => REQUIRED_FIELD_LABELS[field]).join(", ")}.`,
    );
  const address = form.addressAsCard ? form.address : form.expectedAddress;
  if (address.street)
    steps.push(
      `Адрес в карточке: ${[address.street, address.house && `д. ${address.house}`, address.building && `корп. ${address.building}`, address.apartment && `кв. ${address.apartment}`].filter(Boolean).join(", ")}${form.addressAsCard ? "" : " (исправленный — в вызове он неверный)"}.`,
    );
  if (form.expectedComment.trim())
    steps.push(`Комментарий по смыслу: «${form.expectedComment.trim()}».`);
  const last = flow[flow.length - 1];
  if (last === "completed") steps.push("Закрыть: «Работы завершены».");
  if (last === "refused") steps.push("Закрыть: «Отказ от выполнения работ».");
  return steps;
}

/** Подсказка текста доклада — преподаватель правит, ничего не отправляется сам. */
export function suggestComment(
  form: ScenarioForm,
  serviceName: (id: string) => string,
): string {
  const where = [
    form.address.city,
    form.address.street,
    form.address.house && `дом ${form.address.house}`,
  ]
    .filter(Boolean)
    .join(", ");
  return `В ${serviceName(form.targetServiceId) || "службу"} передана информация: ${form.incidentClass || "происшествие"}. ${where}.`;
}

/** Службы карточки сценария — кому адресовано происшествие. */
export function scenarioServiceIds(scenario: Scenario): string[] {
  return scenario.card.service_ids ?? [];
}

export type ScenarioConstructor = components["schemas"]["ScenarioConstructor"];
export type ScenarioPreviewResult = components["schemas"]["ScenarioPreview"];

/** Запрос конструктора C-05 из того, что преподаватель уже выбрал в форме. */
export function constructorFromForm(
  form: ScenarioForm,
  seed: number,
): ScenarioConstructor {
  return {
    incident_type_code: form.incidentTypeCode,
    target_service_id: form.targetServiceId,
    address: { ...EMPTY_ADDRESS, ...form.address },
    victims: form.victims,
    complications: [...form.complications],
    level: form.level,
    weight: form.weight,
    seed,
  };
}

/**
 * Форма из сценария, собранного сервером: факты и эталон — от конструктора,
 * а номер, версия и статус остаются у редактируемого сценария — сервер ничего
 * не сохранил, это только предложение.
 */
export function formFromPreview(
  form: ScenarioForm,
  preview: Pick<ScenarioPreviewResult, "scenario">,
): ScenarioForm {
  const built = formFromScenario(preview.scenario);
  return {
    ...built,
    id: form.id,
    version: form.version,
    status: form.status,
    number: form.number,
    teacherComment: form.teacherComment,
  };
}
