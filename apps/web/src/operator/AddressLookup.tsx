import { useId, useState } from "react";
import source from "./streets.json";
import { addressLine, type Address } from "./model";
import styles from "./AddressLookup.module.css";

export interface StreetSuggestion {
  city: string;
  street: string;
  okrug: string;
  district: string;
  aliases?: readonly string[];
}

export const TRAINING_STREETS: readonly StreetSuggestion[] = source.streets;
const normalized = (text: string) =>
  text.toLocaleLowerCase("ru-RU").replaceAll("ё", "е");

/** Дом вводит оператор; справочник улиц не подставляет ответ текущего сценария. */
export function addressParts(text: string) {
  const number = text.match(
    /(\d+[а-я]?)(?:\s*(?:корпус|корп|к)\.?\s*(\d+[а-я]?))?/i,
  );
  return {
    street: text
      .replace(/\d[\s\S]*$/, "")
      .replace(/[,\s]+(?:д|дом)\.?\s*$/i, "")
      .trim(),
    house: number?.[1] ?? "",
    building: number?.[2],
  };
}

export function streetSuggestions(text: string): readonly StreetSuggestion[] {
  const words = normalized(addressParts(text).street)
    .split(/[\s,.]+/)
    .filter(
      (word) =>
        word && !["г", "москва", "улица", "ул", "россия"].includes(word),
    );
  if (!words.length) return [];
  return TRAINING_STREETS.filter((street) =>
    words.every((word) =>
      [street.street, ...(street.aliases ?? [])].some((name) =>
        normalized(name).includes(word),
      ),
    ),
  );
}

export function chooseStreet(
  address: Address,
  query: string,
  street: StreetSuggestion,
): Address {
  const parts = addressParts(query);
  return {
    ...address,
    subject: street.city,
    locality: street.city,
    street: street.street,
    okrug: street.okrug,
    district: street.district,
    house: parts.house || address.house,
    korpus: parts.building ?? address.korpus,
  };
}

export function AddressLookup({
  address,
  onChange,
}: {
  address: Address;
  onChange: (next: Address) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const suggestions = focused ? streetSuggestions(query) : [];
  const choose = (street: StreetSuggestion) => {
    onChange(chooseStreet(address, query, street));
    setFocused(false);
  };
  return (
    <div className={styles.lookup}>
      <input
        role="combobox"
        aria-label="Адрес одной строкой"
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        aria-controls={id}
        aria-activedescendant={
          suggestions.length ? `${id}-${active}` : undefined
        }
        value={focused ? query : addressLine(address)}
        placeholder="Улица и дом"
        onFocus={() => {
          // Значение при фокусе не меняется: выделение текста остаётся на месте.
          setQuery(addressLine(address));
          setActive(0);
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setFocused(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setFocused(false);
          }
          if (!suggestions.length) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive(
              (value) =>
                (value +
                  (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) %
                suggestions.length,
            );
          }
          if (event.key === "Enter") {
            event.preventDefault();
            choose(suggestions[active]!);
          }
        }}
      />
      {suggestions.length > 0 && (
        <ul id={id} role="listbox" aria-label="Подсказки улиц">
          {suggestions.map((street, index) => (
            <li
              key={street.street}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(street)}
            >
              <span>{street.street}</span>
              <small>
                {[street.city, street.okrug, street.district]
                  .filter(Boolean)
                  .join(", ")}
              </small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
