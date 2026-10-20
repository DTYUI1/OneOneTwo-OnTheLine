// Набор номера кнопками (HQ-023): в узком окне телефона ДДС набор и справочник не помещаются
// рядом (правка 19.10), поэтому они — две вкладки: «Набор» (поле «Номер», клавиатура 3 × 4 с
// нижним рядом «пусто, 0, стереть» и «Позвонить») и «Справочник» (контакты, доклады бригад).
// Кнопки дописывают в то же поле, что и клавиатура компьютера; «Позвонить» отправляет форму —
// путь звонка один (Softphone, `dialTyped`). Кнопки клавиатуры пробел не держат
// (pushToTalk.ts), но видны только вне разговора: разговору пробел не нужен, пока на экране
// контакты.
import { useState, type ReactNode } from "react";
import { DIAL_KEYS, eraseLast, pressKey } from "./dialKeys";
import styles from "./DialPad.module.css";

/** Какая вкладка открыта: справочник — с него начинают, набор — когда номер знают. */
type View = "contacts" | "pad";

export function DialPad({
  value,
  onChange,
  onSubmit,
  disabled,
  blocked,
  status,
  children,
}: {
  /** Набранный номер — поле «Номер». */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** «Позвонить»: тот же звонок, что Enter в поле. */
  readonly onSubmit: () => void;
  readonly disabled: boolean;
  /** Почему набрать нельзя — подсказка на неактивных кнопках (TC-08). */
  readonly blocked?: string;
  /** Строка состояния набора: «Номер недоступен.», пояснения. */
  readonly status: ReactNode;
  /** Вкладка «Справочник» — список контактов. */
  readonly children: ReactNode;
}) {
  const [view, setView] = useState<View>("contacts");
  const empty = !value.trim();
  const tab = (id: View, label: string) => (
    <button
      type="button"
      role="tab"
      className={styles.tab}
      aria-selected={view === id}
      onClick={() => setView(id)}
    >
      {label}
    </button>
  );
  return (
    <div className={styles.split}>
      <div className={styles.tabs} role="tablist" aria-label="Телефон">
        {tab("contacts", "Справочник")}
        {tab("pad", "Набор")}
      </div>
      <form
        className={styles.pad}
        data-help="phone-dial"
        aria-label="Набор номера"
        hidden={view !== "pad"}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className={styles.field}>
          <input
            aria-label="Номер"
            inputMode="tel"
            placeholder="Номер"
            value={value}
            disabled={disabled}
            title={blocked}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
        <div className={styles.keys} role="group" aria-label="Клавиатура">
          {DIAL_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className={
                key === "0" ? `${styles.key} ${styles.zero}` : styles.key
              }
              title={blocked}
              disabled={disabled}
              onClick={() => onChange(pressKey(value, key))}
            >
              {key}
            </button>
          ))}
          <button
            type="button"
            className={styles.key}
            aria-label="Стереть последнюю цифру"
            title={blocked ?? "Стереть последнюю цифру"}
            disabled={disabled || empty}
            onClick={() => onChange(eraseLast(value))}
          >
            ⌫
          </button>
        </div>
        <button
          type="submit"
          className={styles.call}
          disabled={disabled || empty}
          title={blocked ?? (empty ? "Введите номер" : undefined)}
        >
          Позвонить
        </button>
      </form>
      <div className={styles.list} hidden={view !== "contacts"}>
        {children}
      </div>
      {/* Строка состояния — под обеими вкладками: ответ на набор виден и из справочника. */}
      <span className={styles.status} role="status">
        {status}
      </span>
    </div>
  );
}
