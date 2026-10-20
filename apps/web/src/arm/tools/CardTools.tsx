import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Card } from "../../shared/api";
import { ArmIcon } from "../ArmIcon";
import { Dialog } from "../Dialog";
import { fullAddress } from "../cardModel";
import { TOOL_HELP, type ToolTopic } from "./toolHelp";
import type { Reminder, ToolsStore } from "./toolsStore";
import rowStyles from "../ArmPage.module.css";
import styles from "./CardTools.module.css";

type Target = Pick<Card, "id" | "source">;
type Panel = { topic: ToolTopic | "timer"; card: Target };
const ToolsContext = createContext<{
  store: ToolsStore;
  now: number;
  show: (topic: Panel["topic"], card: Target) => void;
} | null>(null);

export function useCardTools() {
  const value = useContext(ToolsContext);
  if (!value) throw new Error("CardToolsProvider is required");
  return value;
}

/** Icon clicks never open or deliver a card as a side effect. */
export function RegistryTools({ card }: { card: Target }) {
  const { store, show } = useCardTools();
  const pinned = store.pinned.includes(card.id);
  const reminder = store.reminders.find((r) => r.cardId === card.id);
  const icon = (
    name: Parameters<typeof ArmIcon>[0]["name"],
    label: string,
    action: () => void,
    active = false,
    pressed?: boolean,
  ) => (
    <button
      type="button"
      className={`${styles.iconButton} ${active ? styles.active : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={(event) => {
        event.stopPropagation();
        action();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <ArmIcon name={name} />
    </button>
  );
  return (
    <>
      <td className={rowStyles.icon}>
        {icon("link", "Связанные карточки — справка тренажёра", () =>
          show("relations", card),
        )}
      </td>
      <td className={rowStyles.icon}>
        {icon(
          "book",
          pinned ? "Открепить карточку" : "Закрепить карточку",
          () => store.togglePin(card.id),
          pinned,
          pinned,
        )}
      </td>
      <td className={rowStyles.icon}>
        {icon("flash", "Важное происшествие — справка тренажёра", () =>
          show("important", card),
        )}
      </td>
      <td className={rowStyles.icon}>
        {icon(
          "timer",
          reminder ? "Изменить напоминание" : "Поставить напоминание",
          () => show("timer", card),
          Boolean(reminder),
        )}
      </td>
      <td className={`${rowStyles.operator} ${rowStyles.optional}`}>—</td>
      <td className={rowStyles.optional}>—</td>
    </>
  );
}

function ToolWindow({
  title,
  onClose,
  children,
  reminder = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  reminder?: boolean;
}) {
  return createPortal(
    <div
      className={styles.backdrop}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Dialog
        label={title}
        className={reminder ? styles.nativeDialog : styles.dialog}
        onClose={onClose}
      >
        <header className={styles.heading}>
          <h2>{title}</h2>
          <button
            type="button"
            aria-label="Закрыть окно"
            title="Закрыть окно"
            onClick={onClose}
          >
            <ArmIcon name="close" />
          </button>
        </header>
        {children}
      </Dialog>
    </div>,
    document.body,
  );
}

const validMinutes = (value: string) =>
  Number.isInteger(Number(value)) &&
  Number(value) >= 1 &&
  Number(value) <= 1440;

/** ПОВ-112, инструкция пользователя, рисунок 80: только два поля и две кнопки. */
function ReminderForm({
  card,
  reminder,
  store,
  onClose,
}: {
  card: Target;
  reminder?: Reminder;
  store: ToolsStore;
  onClose: () => void;
}) {
  const [minutes, setMinutes] = useState(
    reminder
      ? String(
          Math.min(
            1440,
            Math.max(1, Math.ceil((reminder.dueAt - Date.now()) / 60000)),
          ),
        )
      : "",
  );
  const [text, setText] = useState(reminder?.text ?? "");
  const valid = validMinutes(minutes) && Boolean(text.trim());
  return (
    <ToolWindow title="Поставить напоминание" onClose={onClose} reminder>
      <form
        className={styles.nativeContent}
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          store.saveReminder({
            cardId: card.id,
            number: card.source.number,
            text: text.trim(),
            dueAt: Date.now() + Number(minutes) * 60000,
          });
          onClose();
        }}
      >
        <div className={styles.inputRow}>
          <label>
            Минуты
            <input
              type="number"
              required
              min="1"
              max="1440"
              step="1"
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
            />
          </label>
          <label>
            О чем напомнить?
            <input
              type="text"
              required
              maxLength={300}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
        </div>
        <div className={styles.nativeActions}>
          <button type="submit" disabled={!valid}>
            сохранить
          </button>
          <button type="button" onClick={onClose}>
            отмена
          </button>
        </div>
      </form>
    </ToolWindow>
  );
}

/** Рисунок 81: карточка, минуты переноса, перенос и удаление; закрытие — повтор через 20 с. */
function ReminderNotice({
  reminder,
  card,
  store,
  onClose,
  onOpen,
}: {
  reminder: Reminder;
  card?: Card;
  store: ToolsStore;
  onClose: () => void;
  onOpen: () => void;
}) {
  const [minutes, setMinutes] = useState("");
  return (
    <ToolWindow
      title={`Напоминание для карточки: ${reminder.number}`}
      onClose={onClose}
      reminder
    >
      <div className={`${styles.nativeContent} ${styles.notice}`}>
        {card && (
          <>
            <p>
              {new Date(card.appeared_at).toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              {new Date(card.appeared_at).toLocaleDateString("ru-RU")},
            </p>
            <p>{fullAddress(card.source.address)}</p>
          </>
        )}
        <p>
          <span className={styles.dim}>что сделать:</span> {reminder.text}
        </p>
        <form
          className={styles.noticeActions}
          onSubmit={(event) => {
            event.preventDefault();
            if (!validMinutes(minutes)) return;
            store.saveReminder({
              ...reminder,
              hiddenUntil: undefined,
              dueAt: Date.now() + Number(minutes) * 60000,
            });
          }}
        >
          <button
            type="button"
            className={styles.openCard}
            disabled={!card}
            onClick={onOpen}
          >
            перейти в карточку
          </button>
          <label>
            Минуты
            <input
              type="number"
              min="1"
              max="1440"
              step="1"
              required
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
            />
          </label>
          <button type="submit" disabled={!validMinutes(minutes)}>
            напомнить позже
          </button>
          <button
            type="button"
            onClick={() => store.removeReminder(reminder.cardId)}
          >
            удалить напоминание
          </button>
        </form>
      </div>
    </ToolWindow>
  );
}

export function CardToolsProvider({
  store,
  now,
  cards,
  openedId,
  onOpen,
  children,
}: {
  store: ToolsStore;
  now: number;
  cards: readonly Card[];
  openedId: string | null;
  onOpen: (id: string) => void;
  children: ReactNode;
}) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const show = (topic: Panel["topic"], card: Target) =>
    setPanel({ topic, card });
  const due = store.reminders
    .filter(
      (r) =>
        r.dueAt <= now && (r.hiddenUntil ?? 0) <= now && r.cardId !== openedId,
    )
    .sort((a, b) => a.dueAt - b.dueAt)[0];
  const dismiss = (reminder: Reminder) =>
    store.saveReminder({ ...reminder, hiddenUntil: Date.now() + 20_000 });
  const help = panel && panel.topic !== "timer" ? TOOL_HELP[panel.topic] : null;
  return (
    <ToolsContext.Provider value={{ store, now, show }}>
      {children}
      {!store.persistent &&
        (store.pinned.length > 0 || store.reminders.length > 0) && (
          <p className={styles.storageWarning} role="status">
            Браузер не сохраняет закладки и напоминания. Они доступны до
            обновления страницы.
          </p>
        )}
      {!panel && due && (
        <ReminderNotice
          key={`${due.cardId}:${due.dueAt}`}
          reminder={due}
          card={cards.find((card) => card.id === due.cardId)}
          store={store}
          onClose={() => dismiss(due)}
          onOpen={() => {
            dismiss(due);
            onOpen(due.cardId);
          }}
        />
      )}
      {panel?.topic === "timer" && (
        <ReminderForm
          key={panel.card.id}
          card={panel.card}
          store={store}
          reminder={store.reminders.find((r) => r.cardId === panel.card.id)}
          onClose={() => setPanel(null)}
        />
      )}
      {panel && help && (
        <ToolWindow
          title={`Справка тренажёра: ${help.title}`}
          onClose={() => setPanel(null)}
        >
          <div className={styles.content}>
            <p>{help.purpose}</p>
            <h3>Когда использовать</h3>
            <p>{help.when}</p>
            <h3>Порядок действий ДДС</h3>
            <ol>
              {help.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </ToolWindow>
      )}
    </ToolsContext.Provider>
  );
}
