// Абоненты телефона ДДС на занятии (GP-09, рекомендации организаторов 16.10, п. 8): кого
// обучаемый набирает с телефона ДДС и под какими условными номерами. Не больше 10 номеров на
// одну ДДС; заявитель доступен, только если преподаватель добавил его в список. Не правили —
// действует список по умолчанию (руководство и аварийная бригада).
import {
  CONTACTS_MAX,
  contactProblems,
  DEFAULT_CONTACTS,
  ROLE_LABELS,
  type ContactRole,
  type PhoneContact,
} from "../../arm/softphone/contacts";
import type { CallerCharacter } from "../../arm/softphone/caller/book";
import styles from "./Console.module.css";

export type ContactLists = Readonly<Record<string, readonly PhoneContact[]>>;
/** Название ДДС по её идентификатору: в подписях — «ЖКХ», а не `GKH`. */
export type ServiceNames = Readonly<Record<string, string>>;

/** Что не так со списками — строки для общего перечня проблем формы. */
export function contactListProblems(
  lists: ContactLists,
  names: ServiceNames = {},
): string[] {
  return Object.entries(lists).flatMap(([serviceId, items]) =>
    contactProblems(items).map(
      (text) => `Телефон ДДС ${names[serviceId] ?? serviceId}: ${text}`,
    ),
  );
}

/** Свободный условный номер: следующий после последнего, в пределах 400–999. */
function nextNumber(items: readonly PhoneContact[]): string {
  const used = new Set(items.map((item) => item.number));
  for (let number = 401; number <= 999; number += 1)
    if (!used.has(String(number))) return String(number);
  return "";
}

export function PhoneContacts({
  serviceIds,
  names = {},
  lists,
  onChange,
}: {
  /** ДДС участников занятия. */
  readonly serviceIds: readonly string[];
  /** Названия ДДС из справочника служб; нет названия — виден идентификатор. */
  readonly names?: ServiceNames;
  /** Списки, которые преподаватель правил; остальные ДДС — по умолчанию. */
  readonly lists: ContactLists;
  readonly onChange: (lists: ContactLists) => void;
}) {
  const edited = Object.keys(lists).length > 0;
  return (
    <details className={styles.panel}>
      <summary className={styles.panelTitle}>
        Телефон ДДС · абоненты ·{" "}
        {edited ? "изменены для этого занятия" : "по умолчанию"}
      </summary>
      <p className={styles.hint}>
        Кому обучаемый может позвонить с телефона ДДС, кроме бригад и служб. Не
        больше {CONTACTS_MAX} номеров на одну ДДС, номер — три цифры от 400 до
        999. Заявителю можно позвонить, только если он есть в списке.
      </p>
      {serviceIds.length === 0 && (
        <p className={styles.hint}>
          Добавьте рабочее место — здесь появится список его ДДС.
        </p>
      )}
      {serviceIds.map((serviceId) => {
        const items = lists[serviceId] ?? DEFAULT_CONTACTS;
        const set = (next: readonly PhoneContact[]) =>
          onChange({ ...lists, [serviceId]: next });
        const patch = (index: number, value: Partial<PhoneContact>) =>
          set(
            items.map((item, i) =>
              i === index ? { ...item, ...value } : item,
            ),
          );
        return (
          <section
            key={serviceId}
            aria-label={`Абоненты телефона ДДС ${names[serviceId] ?? serviceId}`}
          >
            <h4>
              {names[serviceId] ?? `Служба ${serviceId}`} · {items.length} из{" "}
              {CONTACTS_MAX}
            </h4>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Кто</th>
                  <th>Подпись в списке</th>
                  <th>Номер</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => (
                  <tr key={index}>
                    <td>
                      <select
                        aria-label="Кто"
                        value={item.role}
                        onChange={(event) => {
                          const role = event.target.value as ContactRole;
                          patch(index, {
                            role,
                            name: ROLE_LABELS[role],
                            character: null,
                          });
                        }}
                      >
                        {Object.entries(ROLE_LABELS).map(([role, label]) => (
                          <option key={role} value={role}>
                            {label}
                          </option>
                        ))}
                      </select>
                      {/* Характер живого заявителя (HQ-019, docs/dds_caller.md): нет — как в сценарии. */}
                      {item.role === "caller" && (
                        <select
                          aria-label="Характер заявителя"
                          value={item.character ?? ""}
                          onChange={(event) =>
                            patch(index, {
                              character:
                                (event.target.value as CallerCharacter) || null,
                            })
                          }
                        >
                          <option value="">как в сценарии</option>
                          <option value="calm">спокойная</option>
                          <option value="confused">растерянная</option>
                        </select>
                      )}
                    </td>
                    <td>
                      <input
                        aria-label="Подпись в списке"
                        value={item.name}
                        maxLength={60}
                        onChange={(event) =>
                          patch(index, { name: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label="Номер"
                        value={item.number}
                        inputMode="numeric"
                        maxLength={3}
                        size={4}
                        onChange={(event) =>
                          patch(index, { number: event.target.value })
                        }
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className={styles.plain}
                        onClick={() => set(items.filter((_, i) => i !== index))}
                      >
                        Убрать
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.plain}
                disabled={items.length >= CONTACTS_MAX}
                title={
                  items.length >= CONTACTS_MAX
                    ? `Не больше ${CONTACTS_MAX} номеров на одну ДДС.`
                    : undefined
                }
                onClick={() =>
                  set([
                    ...items,
                    {
                      role: "caller",
                      name: ROLE_LABELS.caller,
                      number: nextNumber(items),
                    },
                  ])
                }
              >
                Добавить абонента
              </button>
              {lists[serviceId] && (
                <button
                  type="button"
                  className={styles.plain}
                  onClick={() => {
                    const rest = { ...lists };
                    delete rest[serviceId];
                    onChange(rest);
                  }}
                >
                  Вернуть по умолчанию
                </button>
              )}
            </div>
          </section>
        );
      })}
    </details>
  );
}
