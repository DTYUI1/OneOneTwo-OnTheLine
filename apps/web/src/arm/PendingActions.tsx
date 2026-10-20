// Разбор очереди неотправленных действий (ws-events.md: UI разбора — T-013).
// Очередь ведёт shared/ws; здесь только показ: что не ушло на сервер и почему. Действие в
// пути не показываем — только отклонённое и застрявшее (outboxNotice.ts).
import { useEffect, useState } from "react";
import type { PendingEvent } from "../shared/ws/outbox";
import { useSession } from "../shared/session";
import { STATE_LABELS } from "./cardModel";
import { noticeItems } from "./outboxNotice";
import styles from "./PendingActions.module.css";

const ACTION_LABELS = {
  deliver: "показ карточки",
  open: "открытие карточки",
  field_change: "правка поля",
  status_change: "смена статуса",
  comment: "комментарий",
  redirect: "перенаправление",
  hint_open: "открытие подсказки",
  call_dial: "набор номера",
  call_dial_target: "вызов адресата",
  call_answer: "ответ абонента",
  call_hangup: "завершение звонка",
  call_hold: "удержание звонка",
  call_resume: "снятие с удержания",
  caller_said: "реплика заявителя",
  brigades_select: "выбор бригад",
  message_presented: "предъявление учебного сообщения",
  message_failed: "ошибка предъявления учебного сообщения",
  brigade_reply: "ответ бригаде",
  brigade_briefing: "вводная бригаде",
  brigade_said: "сказано бригаде",
  report_confirmed: "подтверждение доклада бригады",
  control_reply: "пояснение отделу контроля",
} satisfies Record<PendingEvent["event"]["type"], string>;

function describe(item: PendingEvent): string {
  const action = ACTION_LABELS[item.event.type];
  if (item.event.type === "status_change")
    return `${action}: ${STATE_LABELS[item.event.payload.state]}`;
  return action;
}

export function PendingActions() {
  const { realtime } = useSession();
  const [items, setItems] = useState<PendingEvent[]>([]);
  // Когда очередь проверяли: по нему видно, какое действие застряло.
  const [checkedAt, setCheckedAt] = useState(0);
  const [clearing, setClearing] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function refresh() {
      const pending = await realtime.pending();
      if (!alive) return;
      setItems(pending);
      setCheckedAt(Date.now());
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [realtime]);

  const shown = noticeItems(items, checkedAt);
  if (shown.length === 0) return null;
  const failed = shown.filter((item) => item.failure);
  const blockedCards = new Set(failed.map((item) => item.cardId));
  async function discard(cardId: string) {
    setClearing(cardId);
    try {
      await realtime.discardBlockedCard(cardId);
      setItems(await realtime.pending());
    } finally {
      setClearing(null);
    }
  }
  return (
    <section
      className={failed.length ? styles.failed : styles.pending}
      role={failed.length ? "alert" : undefined}
    >
      <strong>
        {failed.length
          ? "Отклонённые действия сохранены. Остановлены только затронутые карточки."
          : "Действия ещё не подтверждены сервером"}
      </strong>
      <ul>
        {shown.map((item) => (
          <li key={item.id}>
            {describe(item)}
            {item.failure
              ? ` — ${item.failure}`
              : blockedCards.has(item.cardId)
                ? " — остановлено после отказа по этой карточке"
                : " — ожидает отправки"}
            {item.failure && (
              <button
                type="button"
                disabled={clearing !== null}
                onClick={() => void discard(item.cardId)}
              >
                {clearing === item.cardId
                  ? "Очищаем…"
                  : `Очистить очередь этой карточки (${items.filter((next) => next.cardId === item.cardId).length})`}
              </button>
            )}
          </li>
        ))}
      </ul>
      {failed.length > 0 && (
        <p>
          Сервер не принял эти действия. Можно очистить очередь затронутой
          карточки и повторить действия в ней; сохранённые на сервере события
          останутся. После очистки обновите страницу перед новым звонком, чтобы
          сбросить незавершённый разговор в браузере.
        </p>
      )}
    </section>
  );
}
