import { useEffect, useId, useState } from "react";
import {
  formatHandlingNormative,
  HANDLING_NORMATIVE_ERROR,
  HANDLING_NORMATIVE_HINT,
  parseHandlingNormative,
} from "./handlingNormative";
import styles from "../teacher/console/Console.module.css";

export function HandlingNormativeField({
  value,
  onChange,
  onCommit,
  disabled = false,
}: {
  value: number;
  onChange: (seconds: number) => void;
  onCommit?: (seconds: number) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(() => formatHandlingNormative(value));
  const [error, setError] = useState("");
  useEffect(() => {
    if (Number.isFinite(value)) {
      setText(formatHandlingNormative(value));
      setError("");
    }
  }, [value]);

  const commit = () => {
    const seconds = parseHandlingNormative(text);
    if (seconds === null) {
      setError(HANDLING_NORMATIVE_ERROR);
      return;
    }
    setText(formatHandlingNormative(seconds));
    onCommit?.(seconds);
  };

  return (
    <div className={styles.normativeField}>
      <label className={styles.field}>
        Отработка карточки
        <input
          type="text"
          placeholder="3:00"
          value={text}
          disabled={disabled}
          className={styles.number}
          aria-invalid={!!error}
          aria-describedby={id}
          onChange={(event) => {
            const next = event.target.value;
            const seconds = parseHandlingNormative(next);
            setText(next);
            setError(seconds === null ? HANDLING_NORMATIVE_ERROR : "");
            // NaN блокирует отправку формы через общую validateSettings.
            onChange(seconds ?? Number.NaN);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </label>
      <p id={id} className={styles.normativeHint}>
        {HANDLING_NORMATIVE_HINT}
      </p>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
