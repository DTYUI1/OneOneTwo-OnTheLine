// Данные экрана оператора 112: копия классификатора и сценариев в бандле.
// Канон — data/classifier.json и data/operator/scenarios; копию собирает и сверяет
// data.test.ts (UPDATE_OPERATOR_DATA=1 pnpm test). Образ web собирается без data/.

import raw from "./data.json";

/** Такие типы в классификаторе оператору 112 не показываются. */
export const HIDDEN_SIGN = "Не отображается оператору 112";

export interface IncidentType {
  readonly code: string;
  readonly groupNo: string;
  readonly groupName: string;
  readonly name: string;
  /** Признаки sign1–sign3 классификатора: где, объект, признак. */
  readonly signs: readonly [string, string, string];
  readonly mainService: string;
}

export interface RoutingRule {
  readonly typeCode: string;
  readonly serviceId: string;
  /** default или тег: victims, no_access, offense, gasification. */
  readonly trigger: string;
}

export interface Service {
  readonly id: string;
  readonly name: string;
}

/** Лишний вопрос шага (этап 3): правдоподобный для шага, но не по делу этого вызова. */
export interface Distractor {
  readonly key: string;
  readonly step: number;
  readonly text: string;
}

export interface CallScenario {
  readonly id: string;
  readonly title: string;
  readonly caller: { readonly name: string; readonly phone: string };
  /** Первая реплика заявителя — звучит сама, когда вызов принят. */
  readonly opening?: string;
  /** Лишние вопросы среди вариантов шагов; ответ на них знает сервер. */
  readonly distractors: readonly Distractor[];
  /** Эталонный порядок звонка — для разбора после «сохранить» (этап 3). */
  readonly reference_order: readonly string[];
  readonly questionnaire_id: string | null;
  /** Кто звонит (этап 2): от персонажа — голос и манера речи. */
  readonly persona: {
    readonly kind: string;
    readonly age: number;
    readonly label: string;
  };
  /** Паника в начале звонка; 3 — истерика: вопросы не слышны без «Успокоить». */
  readonly start_panic: number;
  /** Фон в трубке — ключ BACKGROUNDS (voiceAssets.ts). */
  readonly background: string;
  /** Когда ситуация ухудшается; время считает веб и сам присылает серверу escalate. */
  readonly escalation?: {
    readonly after_question: string;
    readonly after_s: number;
    readonly latest_s: number;
  };
  /** Советы заявителю — меню «Советы»: что говорит оператор. */
  readonly advice: readonly { readonly key: string; readonly text: string }[];
}

/** Сценарий в data/operator/scenarios/ — в бандл идёт только то, что нужно экрану. */
export interface SourceScenario
  extends Omit<CallScenario, "escalation" | "advice" | "distractors"> {
  readonly escalation?: CallScenario["escalation"] & Record<string, unknown>;
  readonly advice?: readonly { readonly key: string; readonly text: string }[];
  readonly distractors: readonly (Distractor & { readonly reply: string })[];
}

/**
 * Опросная карта: вопросы для типов её группы классификатора. Этап 3: у вопроса — шаг
 * опроса (1 — адрес … 5 — детали и доступ); у повтора адреса текст — шаблон с {address}.
 */
export interface Questionnaire {
  readonly id: string;
  readonly group_name: string;
  readonly questions: readonly {
    readonly key: string;
    readonly text: string;
    readonly step: number;
  }[];
}

export interface OperatorData {
  readonly types: readonly IncidentType[];
  readonly rules: readonly RoutingRule[];
  readonly services: readonly Service[];
  readonly scenarios: readonly CallScenario[];
  readonly questionnaires: readonly Questionnaire[];
}

/** Сжатый вид: строки через «|», чтобы prettier не разворачивал тысячи записей. */
export interface RawOperatorData {
  readonly services: string[];
  readonly types: string[];
  readonly rules: string[];
  readonly scenarios: CallScenario[];
  readonly questionnaires: Questionnaire[];
}

interface SourceClassifier {
  incident_types: {
    code: string;
    group_no: string;
    group_name: string;
    name: string;
    sign1: string;
    sign2: string;
    sign3: string;
    main_service_code: string;
  }[];
  routing_rules: {
    incident_type_code: string;
    service_id: string;
    condition: { trigger: string };
  }[];
  services: { id: string; name: string; is_active: boolean }[];
}

const clean = (value: string) => value.replaceAll("|", "/").trim();

export function compactData(
  classifier: SourceClassifier,
  scenarios: readonly SourceScenario[],
  questionnaires: readonly Questionnaire[],
): RawOperatorData {
  const types = classifier.incident_types.filter(
    (row) => row.sign1 !== HIDDEN_SIGN,
  );
  const visible = new Set(types.map((row) => row.code));
  const rules = classifier.routing_rules
    .filter((rule) => visible.has(rule.incident_type_code))
    .map((rule) =>
      [rule.incident_type_code, rule.service_id, rule.condition.trigger].join(
        "|",
      ),
    );
  return {
    services: classifier.services
      .filter((service) => service.is_active)
      .map((service) => [service.id, clean(service.name)].join("|")),
    types: types.map((row) =>
      [
        row.code,
        row.group_no,
        row.group_name,
        row.name,
        row.sign1,
        row.sign2,
        row.sign3,
        row.main_service_code,
      ]
        .map(clean)
        .join("|"),
    ),
    rules: [...new Set(rules)],
    scenarios: scenarios.map(
      ({
        id,
        title,
        caller,
        opening,
        questionnaire_id,
        distractors,
        reference_order,
        persona,
        start_panic,
        background,
        escalation,
        advice,
      }) => ({
        id,
        title,
        caller: { name: caller.name, phone: caller.phone },
        ...(opening ? { opening } : {}),
        questionnaire_id,
        distractors: distractors.map(({ key, step, text }) => ({
          key,
          step,
          text,
        })),
        reference_order,
        persona: { kind: persona.kind, age: persona.age, label: persona.label },
        start_panic,
        background,
        ...(escalation
          ? {
              escalation: {
                after_question: escalation.after_question,
                after_s: escalation.after_s,
                latest_s: escalation.latest_s,
              },
            }
          : {}),
        advice: (advice ?? []).map(({ key, text }) => ({ key, text })),
      }),
    ),
    questionnaires: questionnaires.map(({ id, group_name, questions }) => ({
      id,
      group_name,
      questions: questions.map(({ key, text, step }) => ({ key, text, step })),
    })),
  };
}

export function parseData(source: RawOperatorData): OperatorData {
  return {
    services: source.services.map((line) => {
      const [id = "", name = ""] = line.split("|");
      return { id, name };
    }),
    types: source.types.map((line) => {
      const [code, groupNo, groupName, name, s1, s2, s3, main] =
        line.split("|");
      return {
        code: code ?? "",
        groupNo: groupNo ?? "",
        groupName: groupName ?? "",
        name: name ?? "",
        signs: [s1 ?? "", s2 ?? "", s3 ?? ""],
        mainService: main ?? "",
      };
    }),
    rules: source.rules.map((line) => {
      const [typeCode = "", serviceId = "", trigger = ""] = line.split("|");
      return { typeCode, serviceId, trigger };
    }),
    scenarios: source.scenarios,
    questionnaires: source.questionnaires,
  };
}

export const OPERATOR_DATA: OperatorData = parseData(raw);
