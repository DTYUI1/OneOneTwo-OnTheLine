// Явный выбор подсказки: текст и ID обновляются вместе, без нативного datalist.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { User } from "../../shared/api";
import { traineeLabel, traineeByText, traineeOptions } from "./traineeModel";
import styles from "./Console.module.css";

export function TraineeInput({
  value,
  trainees,
  usedIds,
  onChange,
}: {
  value: string;
  trainees: readonly User[];
  usedIds: readonly string[];
  onChange: (userId: string) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  const chosen = trainees.find((user) => user.id === value);
  const [text, setText] = useState(chosen ? traineeLabel(chosen) : "");
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (chosen) setText(traineeLabel(chosen));
  }, [chosen]);
  const options = traineeOptions(trainees, usedIds, value, text);
  useLayoutEffect(() => {
    if (!expanded) return;
    const place = () => {
      const rect = input.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const upward = below < 160 && above > below;
      const height = Math.min(220, Math.max(0, upward ? above : below));
      const width = Math.min(Math.max(rect.width, 360), window.innerWidth - 16);
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        width,
        maxHeight: height,
        ...(upward
          ? { bottom: window.innerHeight - rect.top }
          : { top: rect.bottom }),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [expanded]);
  const invalid = text.trim() !== "" && !chosen;
  function choose(user: User) {
    setText(traineeLabel(user));
    onChange(user.id);
    setExpanded(false);
  }
  return (
    <div
      className={styles.traineeChoice}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setExpanded(false);
      }}
    >
      <input
        ref={input}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded && options.length > 0}
        aria-controls={id}
        aria-activedescendant={
          expanded && options[active]
            ? `${id}-${options[active].id}`
            : undefined
        }
        value={text}
        placeholder="Введите ФИО или логин обучаемого"
        aria-label="Обучаемый"
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-hint` : undefined}
        onFocus={() => setExpanded(true)}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          setExpanded(true);
          setActive(0);
          onChange(traineeByText(trainees, next)?.id ?? "");
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setExpanded(false);
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setExpanded(true);
            setActive((index) =>
              Math.max(
                0,
                Math.min(
                  options.length - 1,
                  index + (event.key === "ArrowDown" ? 1 : -1),
                ),
              ),
            );
          }
          if (event.key === "Enter" && expanded && options[active]) {
            event.preventDefault();
            choose(options[active]);
          }
        }}
      />
      {expanded &&
        options.length > 0 &&
        createPortal(
          <ul
            id={id}
            style={position}
            role="listbox"
            aria-label="Обучаемые"
            className={styles.traineeOptions}
          >
            {options.map((user, index) => (
              <li
                key={user.id}
                role="option"
                id={`${id}-${user.id}`}
                aria-selected={index === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(user)}
              >
                {traineeLabel(user)}
              </li>
            ))}
          </ul>,
          document.body,
        )}
      {invalid && (
        <p id={`${id}-hint`} className={styles.hint}>
          Выберите обучаемого из списка
        </p>
      )}
    </div>
  );
}
