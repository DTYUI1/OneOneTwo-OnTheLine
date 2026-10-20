import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { BUTTON_EXPLANATIONS, type ExplanationKey } from "./buttons";
import { clock, type CallJournal } from "./journal";
import { createCallerAudio } from "./voice";
import { CALLER_VOICES } from "./voiceAssets";
import styles from "./ButtonPanel.module.css";

/** Подсказка у значка не закрывает карточку и не останавливает разговор. */
export function ButtonPanel({
  anchor,
  title,
  children,
  onClose,
}: {
  anchor: HTMLElement;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [position, setPosition] = useState({ left: 12, top: 12 });
  useLayoutEffect(() => {
    const place = () => {
      const target = anchor.getBoundingClientRect();
      const box = panel.current!.getBoundingClientRect();
      const below = target.bottom + 8;
      setPosition({
        left: Math.max(12, Math.min(target.left, innerWidth - box.width - 12)),
        top: Math.max(
          12,
          Math.min(
            below + box.height <= innerHeight - 12
              ? below
              : target.top - box.height - 8,
            innerHeight - box.height - 12,
          ),
        ),
      });
    };
    const observer = new ResizeObserver(place);
    observer.observe(panel.current!);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    place();
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      if (anchor.isConnected) anchor.focus({ preventScroll: true });
    };
  }, [anchor]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !anchor.contains(event.target)
      )
        onClose();
    };
    document.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={panel}
      className={styles.panel}
      role="dialog"
      aria-labelledby={titleId}
      style={position}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button type="button" aria-label="Закрыть подсказку" onClick={onClose}>
          ×
        </button>
      </header>
      {children}
    </div>,
    document.body,
  );
}

export function ButtonExplanation({
  item,
  message,
  onHelp,
}: {
  item: ExplanationKey;
  message?: string;
  onHelp: (topic: string) => void;
}) {
  const explanation: { arm: string; trainer: string; help?: string } =
    BUTTON_EXPLANATIONS[item];
  return (
    <>
      {message && <p role="status">{message}</p>}
      <p>
        <strong>В АРМ 112:</strong> {explanation.arm}
      </p>
      <p>
        <strong>В тренажёре:</strong> {explanation.trainer}
      </p>
      {explanation.help && (
        <button type="button" onClick={() => onHelp(explanation.help!)}>
          Открыть раздел справки «?»
        </button>
      )}
    </>
  );
}

export function CallRecordings({ journal }: { journal: CallJournal }) {
  const audio = useMemo(() => createCallerAudio(), []);
  useEffect(() => () => audio.stop(), [audio]);
  const replies = journal.events.filter((event) => event.reply);
  if (replies.length === 0) return <p>Записей пока нет</p>;
  return (
    <ol className={styles.recordings} aria-label="Реплики заявителя">
      {replies.map((event, index) => (
        <li key={index}>
          <time>{clock(event.t)}</time>
          <p>{event.reply}</p>
          {event.voice && CALLER_VOICES[event.voice] ? (
            <button
              type="button"
              aria-label={`Прослушать реплику ${index + 1}`}
              onClick={() => audio.replay(event.voice!)}
            >
              Прослушать
            </button>
          ) : (
            <span>Голосовая запись недоступна</span>
          )}
        </li>
      ))}
    </ol>
  );
}
