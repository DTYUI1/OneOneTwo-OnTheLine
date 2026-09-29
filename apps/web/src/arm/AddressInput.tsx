// Ручной ввод адреса обучаемым (D-03, CardCurrent.address). Исходный адрес карточки
// (source.address) остаётся как есть; введённое уходит отдельным field_change и
// сравнивается оценщиком с доступными обучаемому сведениями (V-02). Поля не
// заполняются исходным адресом: заказчик — «адрес указывают и могут ошибиться при наборе».
// Адрес сохраняется сам, когда фокус уходит из полей или нажат Enter: обучаемый
// набирал адрес и шёл ставить статус, а несохранённый адрес оценщик не видел.
import { useRef, useState, type FocusEvent } from "react";
import type { ManualAddress } from "./useCardActions";
import styles from "./IncidentCard.module.css";

const EMPTY: ManualAddress = {
  city: "",
  street: "",
  house: "",
  building: "",
  apartment: "",
};

function trim(value: ManualAddress): ManualAddress {
  return Object.fromEntries(
    Object.entries(value).map(([key, part]) => [key, part.trim()]),
  ) as unknown as ManualAddress;
}

const FIELDS: [keyof ManualAddress, string][] = [
  ["city", "Город"],
  ["street", "Улица"],
  ["house", "Дом"],
  ["building", "Корпус"],
  ["apartment", "Квартира"],
];

export function AddressInput({
  saved,
  disabled,
  onSave,
}: {
  saved: ManualAddress | null;
  disabled: boolean;
  onSave: (value: ManualAddress) => Promise<boolean>;
}) {
  const [value, setValue] = useState<ManualAddress>(saved ?? EMPTY);
  const [pending, setPending] = useState(false);
  const latest = useRef(value);
  latest.current = value;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const busy = useRef(false);
  const again = useRef(false);
  const lastSent = useRef<string | null>(null);
  const dirty = JSON.stringify(value) !== JSON.stringify(saved ?? EMPTY);
  const empty = !value.street.trim() && !value.house.trim();

  async function save() {
    if (disabled) return;
    // Запись ещё уходит — сохраним то, что набрано к её концу, а не потеряем.
    if (busy.current) {
      again.current = true;
      return;
    }
    const sent = latest.current;
    const clean = trim(sent);
    const body = JSON.stringify(clean);
    if (
      JSON.stringify(sent) === JSON.stringify(savedRef.current ?? EMPTY) ||
      body === lastSent.current ||
      (!clean.street && !clean.house)
    )
      return;
    busy.current = true;
    setPending(true);
    const ok = await onSave(clean);
    if (ok) lastSent.current = body;
    // Пока запись уходила, обучаемый мог продолжить набор — его не затираем.
    if (ok && latest.current === sent) setValue(clean);
    busy.current = false;
    setPending(false);
    if (again.current) {
      again.current = false;
      void save();
    }
  }

  function leave(event: FocusEvent<HTMLFieldSetElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
      void save();
  }

  // Пока адреса нет, поле выделено: без него оценка адреса — критическая ошибка.
  const needed = !disabled && !saved && !dirty;
  const state =
    saved && !dirty
      ? "сохранён"
      : pending
        ? "сохраняется…"
        : dirty && empty
          ? "укажите улицу и дом"
          : dirty
            ? "сохранится, когда перейдёте к другому полю"
            : "адрес ещё не введён";

  return (
    <fieldset
      className={`${styles.manualAddress} ${needed ? styles.manualNeeded : ""}`}
      disabled={disabled}
      onBlur={leave}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement)
          void save();
      }}
    >
      <legend>Адрес — ввод диспетчера</legend>
      <div className={styles.manualFields}>
        {FIELDS.map(([key, label]) => (
          <label key={key}>
            <span>{label}</span>
            <input
              value={value[key]}
              maxLength={200}
              aria-label={`Адрес: ${label.toLowerCase()}`}
              onChange={(event) =>
                setValue({ ...value, [key]: event.target.value })
              }
            />
          </label>
        ))}
      </div>
      <div className={styles.manualActions}>
        <button
          type="button"
          disabled={!dirty || empty || pending}
          onClick={() => void save()}
        >
          Сохранить адрес
        </button>
        <span
          className={`${styles.manualState} ${saved && !dirty ? styles.manualSaved : ""}`}
          role="status"
        >
          {state}
        </span>
      </div>
    </fieldset>
  );
}
