import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api";
import type { components } from "../../api-client/schema";
import { STATE_LABELS } from "../../arm/cardModel";
import type { ScenarioForm } from "./studioModel";
import { OUTCOME_FLOWS, outcomeOf } from "./studioModel";
import styles from "./Studio.module.css";

type Plan = components["schemas"]["TrainingPlan"];
type Event = components["schemas"]["ScenarioEvent"];
const stateName = (state: string) =>
  STATE_LABELS[state as keyof typeof STATE_LABELS] ?? state;
const kinds: Record<Event["kind"], string> = {
  readback_error: "Бригада повторяет адрес с ошибкой",
  clarify: "Вопрос бригады",
  request_service: "Просьба вызвать службу",
  silence: "Бригада не выходит на связь",
  alarm: "Тревога бригады",
};
export const levelDescription: Record<number, string> = {
  1: "базовая работа с карточкой; конкретные этапы и события перечислены ниже.",
  2: "усложнённая работа с карточкой; конкретные этапы и события перечислены ниже.",
  3: "ловушка повтора адреса и вопрос бригады или просьба вызвать службу — два события с вариантами развития.",
  4: "как на уровне 3, плюс тревога или молчание бригады.",
};

function expectation(
  item: Event["expect"][number],
  event: Event,
  form?: ScenarioForm,
) {
  const actions = {
    answer_call: "Ответить на вызов",
    call_brigade: "Позвонить бригаде",
    correct_readback: "Поправить неверный адрес",
    reply: "Ответить на вопрос бригады",
    call_service: "Вызвать службу",
  };
  let text = actions[item.action];
  if (item.action === "call_service")
    text += ` по номеру ${item.phone_exts.join(" или ")}`;
  if (item.action === "reply") {
    const option = event.reply_options?.find((o) => o.key === item.option_key);
    if (option) {
      const fields: Record<string, string> = {
        caller_name: form?.callerName || "имя заявителя из карточки",
        caller_phone: form?.phoneAon || "телефон заявителя из карточки",
        address: form
          ? [
              form.address.city,
              form.address.street,
              form.address.house && `д. ${form.address.house}`,
              form.address.building && `корп. ${form.address.building}`,
              form.address.apartment && `кв. ${form.address.apartment}`,
            ]
              .filter(Boolean)
              .join(", ")
          : "адрес из карточки",
      };
      text += `: «${option.label.replace(/\{(caller_name|caller_phone|address)\}/g, (_, key: string) => fields[key])}»`;
    }
  }
  return `${text} — в течение ${item.within_s} с${item.critical ? " (обязательно: пропуск — критическая ошибка)" : ""}`;
}

export function courseRows(plan: Plan, flow: string[], form?: ScenarioForm) {
  const messages = new Map(plan.messages.map((m) => [m.message.id, m]));
  const events = new Map((plan.events ?? []).map((e) => [e.id, e]));
  const stage = (state: string) => {
    const index = flow.indexOf(state);
    return index < 0 ? flow.length : index;
  };
  const messageRank = (id: string) => {
    const m = messages.get(id);
    return m
      ? stage(m.justifies_state ?? m.requires_state ?? "accepted") * 1000 -
          100 +
          m.available_after_s / 1000
      : 0;
  };
  function eventRank(event: Event, visited = new Set<string>()): number {
    if (visited.has(event.id)) return flow.length * 1000;
    visited.add(event.id);
    const t = event.trigger;
    if (t.on === "message")
      return messageRank(t.message_id) + 1 + t.after_s / 1000;
    if (t.on === "event") {
      const parent = events.get(t.event_id);
      return (parent ? eventRank(parent, visited) : 0) + 1 + t.after_s / 1000;
    }
    if (t.on === "inject")
      return stage(t.requires_state ?? "accepted") * 1000 + 1;
    return (
      stage(t.state) * 1000 +
      (t.on === "no_contact" ? t.silent_s : t.after_s) / 1000
    );
  }
  function moment(event: Event) {
    const t = event.trigger;
    if (t.on === "message") {
      const m = messages.get(t.message_id);
      return `После доклада «${m?.justifies_state ? stateName(m.justifies_state) : (m?.message.text ?? "бригады")}», через ${t.after_s} с`;
    }
    if (t.on === "event")
      return `После события «${events.get(t.event_id)?.review.label ?? "предыдущее событие"}»: ${t.branch === "wrong" ? "неверный ответ" : "пропущено"}, через ${t.after_s} с`;
    if (t.on === "inject")
      return `По команде преподавателя${t.requires_state ? ` после «${stateName(t.requires_state)}»` : ""}`;
    if (t.on === "no_contact")
      return `После «${stateName(t.state)}»: нет связи ${t.silent_s} с`;
    return `После «${stateName(t.state)}», через ${t.after_s} с`;
  }
  const rows = plan.messages.map((m) => ({
    id: m.message.id,
    order: messageRank(m.message.id),
    title: m.justifies_state ? stateName(m.justifies_state) : "Доклад бригады",
    moment: `${m.requires_state ? `После «${stateName(m.requires_state)}» и соединения с бригадой` : "После соединения с бригадой"}, через ${m.available_after_s} с`,
    text: m.message.text,
    actions: [] as string[],
    branches: [] as string[],
  }));
  for (const event of plan.events ?? []) {
    const branches = (["wrong", "late", "missed"] as const).flatMap((key) => {
      const branch = event.branches[key];
      if (!branch) return [];
      const effects = branch.effects.map((effect) =>
        "delay" in effect
          ? `доклад задержится на ${effect.by_s} с`
          : `вместо доклада: «${effect.with.text}»`,
      );
      if (branch.awaits_call)
        effects.push(`ожидается звонок: ${branch.awaits_call.within_s} с`);
      return [
        `${{ wrong: "Неверный ответ", late: "Опоздание", missed: "Нет действия" }[key]}: ${[branch.line?.text, ...effects].filter(Boolean).join("; ") || "без дополнительных изменений"}`,
      ];
    });
    rows.push({
      id: event.id,
      order: eventRank(event),
      title: kinds[event.kind],
      moment: moment(event),
      text: event.line?.text ?? "",
      actions: event.expect.map((item) => expectation(item, event, form)),
      branches,
    });
  }
  return rows.sort((a, b) => a.order - b.order);
}

export function ScenarioCourse({
  form,
  creating,
}: {
  form: ScenarioForm;
  creating: boolean;
}) {
  const content = useQuery({
    queryKey: ["scenario-content", form.id],
    queryFn: async () => {
      const { data, error } = await api.GET("/scenarios/{id}/content", {
        params: { path: { id: form.id } },
      });
      if (!data)
        throw new Error(error?.message ?? "Не удалось загрузить ход сценария.");
      return data;
    },
    enabled: !creating,
  });
  const plan = content.data?.training_plan;
  // Изменённый в форме исход показываем сразу, не выдавая старый исход за новый.
  const original = form.originalReference?.expected_flow;
  const expected =
    original && outcomeOf(original) === form.outcome
      ? original
      : OUTCOME_FLOWS[form.outcome];
  return (
    <section
      aria-label="Ход и осложнения"
      className={`${styles.preview} ${styles.course}`}
    >
      <h3 className={styles.previewTitle}>Ход и осложнения</h3>
      <p>
        <strong>Уровень {form.level}:</strong> {levelDescription[form.level]}
      </p>
      {form.variantLabel && <p>Вариант: {form.variantLabel}</p>}
      {!creating && content.isPending && <p>Загружаем ход сценария…</p>}
      {!creating && content.isError && (
        <p role="alert">
          Не удалось загрузить ход сценария.{" "}
          <button type="button" onClick={() => void content.refetch()}>
            Повторить
          </button>
        </p>
      )}
      {plan ? (
        <>
          <p className={styles.muted}>
            Порядок по этапам. Время указано относительно события или доклада;
            при разных действиях обучаемого ход меняется.
          </p>
          <ol className={styles.steps}>
            {courseRows(plan, expected, form).map((row) => (
              <li key={row.id}>
                <strong>{row.title}</strong>
                <div>{row.moment}</div>
                {row.text && <p>Бригада: «{row.text}»</p>}
                {row.actions.map((action) => (
                  <p key={action}>Действие: {action}</p>
                ))}
                {row.branches.map((branch) => (
                  <p key={branch}>{branch}</p>
                ))}
              </li>
            ))}
          </ol>
          {plan.outcome && (
            <p>
              <strong>Исход:</strong> {plan.outcome.people}
              <br />
              При задержке: {plan.outcome.late}
            </p>
          )}
        </>
      ) : (
        (creating || content.isSuccess) && (
          <p>
            Учебный план с докладами и событиями не задан. Ниже показан конечный
            статус по эталону.
          </p>
        )
      )}
      <p>
        <strong>Конечный статус:</strong>{" "}
        {stateName(expected.at(-1) ?? "не задан")}
      </p>
    </section>
  );
}
