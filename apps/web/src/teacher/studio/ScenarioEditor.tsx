// Редактор сценария без JSON: происшествие, карточка, адрес, эталон, звонок.
// Ошибки — у своих разделов; 409 предлагает выход (копия или свежая версия).
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import {
  COMPLICATION_LABELS,
  EMPTY_ADDRESS,
  ORIGIN_LABELS,
  OUTCOME_LABELS,
  REQUIRED_FIELD_LABELS,
  STATUS_LABELS,
  conflictKind,
  copyForm,
  formFromScenario,
  hasErrors,
  scenarioFromForm,
  sectionForServerError,
  serviceForType,
  suggestComment,
  validateForm,
  type Complication,
  type FormErrors,
  type FormSection,
  type Outcome,
  type RequiredField,
  type ScenarioForm,
  type Service,
} from "./studioModel";
import { ScenarioPreview } from "./ScenarioPreview";
import { ConstructorPanel } from "./ConstructorPanel";
import { draftKey, readJSON, removeKey, writeJSON } from "../persist";
import kit from "../console/Console.module.css";
import { ScenarioSource } from "./ScenarioSource";
import styles from "./Studio.module.css";

type Address = ScenarioForm["address"];
const ADDRESS_FIELDS: [keyof Address, string][] = [
  ["city", "Город"],
  ["okrug", "Округ"],
  ["district", "Район"],
  ["street", "Улица"],
  ["house", "Дом"],
  ["building", "Корпус"],
  ["apartment", "Квартира"],
];

export function ScenarioEditor({
  initial,
  isNew,
  services,
  newId,
  newNumber,
  onClose,
}: {
  initial: ScenarioForm;
  isNew: boolean;
  services: Service[];
  newId: () => string;
  newNumber: () => string;
  onClose: (notice?: string) => void;
}) {
  const queries = useQueryClient();
  const [form, setForm] = useState(initial);
  const [creating, setCreating] = useState(isNew);
  const [serverErrors, setServerErrors] = useState<FormErrors>({});
  const [conflict, setConflict] = useState<"assigned" | "stale" | null>(null);
  const [notice, setNotice] = useState("");
  const [triedApprove, setTriedApprove] = useState(false);

  // Несохранённые правки переживают перезагрузку: пишем их в sessionStorage,
  // пока форма отличается от последней сохранённой версии.
  const baseline = useRef(JSON.stringify(initial));
  const [pendingDraft, setPendingDraft] = useState<{
    form: ScenarioForm;
    savedAt: string;
  } | null>(() => {
    const stored = readJSON<{ form: ScenarioForm; savedAt: string }>(
      draftKey(initial.id),
    );
    return stored && JSON.stringify(stored.form) !== JSON.stringify(initial)
      ? stored
      : null;
  });
  useEffect(() => {
    if (pendingDraft) return; // пока не решили судьбу старого черновика — не затираем
    if (JSON.stringify(form) === baseline.current) removeKey(draftKey(form.id));
    else
      writeJSON(draftKey(form.id), {
        form,
        savedAt: new Date().toISOString(),
      });
  }, [form, pendingDraft]);

  const types = useQuery({
    queryKey: ["incident-types"],
    queryFn: async () => {
      const { data } = await api.GET("/incident-types");
      return data ?? [];
    },
    staleTime: Infinity,
  });
  const serviceName = (id: string) =>
    services.find((service) => service.id === id)?.name ?? id;
  const typeLabel = (code: string) => {
    const type = types.data?.find((item) => item.code === code);
    return type ? `${type.name} — ${code}` : code;
  };
  const [typeQuery, setTypeQuery] = useState(
    initial.incidentTypeCode ? typeLabel(initial.incidentTypeCode) : "",
  );

  const localErrors = useMemo(
    () => validateForm(form, triedApprove ? "approve" : "draft"),
    [form, triedApprove],
  );
  const errorsFor = (section: FormSection) => [
    ...(localErrors[section] ?? []),
    ...(serverErrors[section] ?? []),
  ];

  const set = (patch: Partial<ScenarioForm>) => {
    setNotice("");
    setServerErrors({});
    setConflict(null);
    setForm((current) => ({ ...current, ...patch }));
  };

  // Служба-адресат по умолчанию тянет за собой звонок и получателя, пока их не
  // меняли вручную: в эталоне это почти всегда одна и та же служба.
  const setTarget = (serviceId: string) => {
    const previous = form.targetServiceId;
    set({
      targetServiceId: serviceId,
      callServiceId:
        !form.callServiceId || form.callServiceId === previous
          ? serviceId
          : form.callServiceId,
      expectedServiceIds:
        form.expectedServiceIds.length === 0 ||
        (form.expectedServiceIds.length === 1 &&
          form.expectedServiceIds[0] === previous)
          ? serviceId
            ? [serviceId]
            : []
          : form.expectedServiceIds,
    });
  };

  const pickType = (value: string) => {
    setTypeQuery(value);
    const code = value.split(" — ").pop() ?? "";
    const type = types.data?.find((item) => item.code === code);
    if (!type) return;
    const mapped = serviceForType(type);
    set({ incidentTypeCode: type.code, incidentClass: type.name });
    if (mapped) setTarget(mapped);
  };

  const save = useMutation({
    mutationFn: async (status: ScenarioForm["status"]) => {
      const body = scenarioFromForm({ ...form, status }, services);
      const header = { "X-CSRF-Token": csrfToken() };
      const result = creating
        ? await api.POST("/scenarios", { params: { header }, body })
        : await api.PUT("/scenarios/{id}", {
            params: { path: { id: form.id }, header },
            body,
          });
      if (!result.data) {
        const status = result.response.status;
        const message = result.error?.message ?? `Ошибка ${status}.`;
        throw Object.assign(new Error(message), { status });
      }
      return result.data;
    },
    onSuccess: async (saved) => {
      removeKey(draftKey(form.id));
      baseline.current = JSON.stringify(formFromScenario(saved));
      setCreating(false);
      setTriedApprove(false);
      setForm(formFromScenario(saved));
      setNotice(
        saved.status === "approved"
          ? `Утверждено, версия ${saved.version}. Сценарий можно выдавать.`
          : `Черновик сохранён, версия ${saved.version}.`,
      );
      await queries.invalidateQueries({ queryKey: ["scenarios"] });
    },
    onError: (cause: Error & { status?: number }) => {
      if (cause.status === 409) {
        const kind = conflictKind(cause.message);
        setConflict(kind === "other" ? null : kind);
        if (kind === "other") setServerErrors({ general: [cause.message] });
        return;
      }
      setServerErrors({
        [sectionForServerError(cause.message)]: [cause.message],
      });
    },
  });

  const submit = (status: "draft" | "approved") => {
    const intent = status === "approved" ? "approve" : "draft";
    setTriedApprove(intent === "approve");
    if (hasErrors(validateForm(form, intent))) return;
    save.mutate(status);
  };

  const makeCopy = () => {
    setConflict(null);
    setServerErrors({});
    setCreating(true);
    removeKey(draftKey(form.id));
    setForm(copyForm({ ...form, number: newNumber() }, newId()));
    setNotice("Это копия: сохраните её как новый черновик.");
  };

  const reload = async () => {
    const { data } = await api.GET("/scenarios/{id}", {
      params: { path: { id: form.id } },
    });
    if (data) {
      setForm(formFromScenario(data));
      setConflict(null);
      setNotice(
        `Загружена актуальная версия ${data.version}. Ваши правки не сохранены.`,
      );
    }
  };

  const readOnly = form.status === "retired";

  return (
    <section className={kit.view} aria-labelledby="editor-title">
      <header className={kit.titleBar}>
        <div>
          <h2 id="editor-title">
            {creating ? "Новый сценарий" : form.incidentClass || "Сценарий"}
          </h2>
          <span className={styles[`st_${form.status}`]}>
            {STATUS_LABELS[form.status]}
          </span>
          <span className={styles.meta}>
            версия {form.version} · источник: {ORIGIN_LABELS[form.origin]}
          </span>
        </div>
        <div className={kit.titleActions}>
          {!readOnly && (
            <>
              <button
                type="button"
                className={kit.plain}
                disabled={save.isPending}
                onClick={() => submit("draft")}
              >
                Сохранить черновик
              </button>
              <button
                type="button"
                className={kit.primary}
                disabled={save.isPending}
                onClick={() => submit("approved")}
              >
                Утвердить
              </button>
            </>
          )}
          <button
            type="button"
            className={kit.dark}
            onClick={() => onClose(notice || undefined)}
          >
            К списку
          </button>
        </div>
      </header>

      {!creating && (
        <ScenarioSource scenarioId={form.id} className={styles.meta} />
      )}

      {pendingDraft && (
        <div className={kit.warning} role="status">
          Есть несохранённые правки этого сценария от{" "}
          {new Date(pendingDraft.savedAt).toLocaleTimeString("ru-RU")}.{" "}
          <button
            type="button"
            className={kit.primary}
            onClick={() => {
              setForm(pendingDraft.form);
              setPendingDraft(null);
            }}
          >
            Восстановить
          </button>{" "}
          <button
            type="button"
            className={kit.plain}
            onClick={() => {
              removeKey(draftKey(initial.id));
              setPendingDraft(null);
            }}
          >
            Отбросить
          </button>
        </div>
      )}
      {conflict === "assigned" && (
        <div className={kit.warning} role="alert">
          Этот сценарий уже выдан на занятии — менять его нельзя, иначе
          разойдутся результаты. Сделайте копию: история назначений исходного
          сохранится.{" "}
          <button type="button" className={kit.primary} onClick={makeCopy}>
            Создать копию
          </button>
        </div>
      )}
      {conflict === "stale" && (
        <div className={kit.warning} role="alert">
          Сценарий успел измениться в другом окне.{" "}
          <button
            type="button"
            className={kit.plain}
            onClick={() => void reload()}
          >
            Загрузить актуальную версию
          </button>
        </div>
      )}
      {readOnly && (
        <p className={kit.warning}>
          Сценарий в архиве: он только для чтения. Чтобы продолжить с ним
          работу, сделайте копию.{" "}
          <button type="button" className={kit.primary} onClick={makeCopy}>
            Создать копию
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className={kit.message}>
          {notice}
        </p>
      )}
      <Errors list={errorsFor("general")} />

      <div className={styles.split}>
        <fieldset className={styles.form} disabled={readOnly || save.isPending}>
          <Section title="Происшествие" errors={errorsFor("incident")}>
            <label className={kit.field}>
              Тип по классификатору
              <input
                list="incident-types"
                value={typeQuery}
                placeholder="начните вводить: пожар, ДТП, лифт…"
                className={styles.grow}
                onChange={(event) => pickType(event.target.value)}
              />
              <datalist id="incident-types">
                {(types.data ?? []).map((type) => (
                  <option key={type.code} value={`${type.name} — ${type.code}`}>
                    {type.group_name}
                  </option>
                ))}
              </datalist>
            </label>
            <div className={kit.actions}>
              <label className={kit.field}>
                Служба-адресат
                <select
                  value={form.targetServiceId}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  <option value="">— выберите —</option>
                  {services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                      {!service.is_active && " — выключена"}
                    </option>
                  ))}
                </select>
              </label>
              <label className={kit.field}>
                Уровень
                <select
                  value={form.level}
                  onChange={(event) =>
                    set({ level: Number(event.target.value) })
                  }
                >
                  {[1, 2, 3, 4].map((level) => (
                    <option key={level} value={level}>
                      {level} —{" "}
                      {
                        ["простой", "средний", "сложный", "особо сложный"][
                          level - 1
                        ]
                      }
                    </option>
                  ))}
                </select>
              </label>
              <label className={kit.field}>
                Вес 1…10
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={form.weight}
                  className={kit.number}
                  onChange={(event) =>
                    set({ weight: Number(event.target.value) })
                  }
                />
              </label>
            </div>
            {form.incidentTypeCode &&
              !serviceForTypeCode(types.data ?? [], form.incidentTypeCode) && (
                <p className={kit.hint}>
                  У этого типа в классификаторе нет службы среди шести учебных —
                  адресат выбран вручную.
                </p>
              )}
            <ConstructorPanel
              form={form}
              disabled={readOnly || save.isPending}
              onApply={(next) => {
                setServerErrors({});
                setForm(next);
              }}
            />
          </Section>

          <Section title="Карточка вызова" errors={errorsFor("card")}>
            <div className={kit.actions}>
              <label className={kit.field}>
                Номер
                <input
                  value={form.number}
                  inputMode="numeric"
                  maxLength={8}
                  className={kit.number}
                  onChange={(event) => set({ number: event.target.value })}
                />
              </label>
              <label className={kit.field}>
                Заявитель
                <input
                  value={form.callerName}
                  onChange={(event) => set({ callerName: event.target.value })}
                />
              </label>
              <label className={kit.field}>
                АОН
                <input
                  value={form.phoneAon}
                  placeholder="+7…"
                  onChange={(event) => set({ phoneAon: event.target.value })}
                />
              </label>
              <label className={kit.field}>
                Предоставленный
                <input
                  value={form.phoneProvided}
                  placeholder="+7…"
                  onChange={(event) =>
                    set({ phoneProvided: event.target.value })
                  }
                />
              </label>
              <label className={kit.field}>
                Телефон на место
                <input
                  value={form.phoneScene}
                  placeholder="+7…"
                  onChange={(event) => set({ phoneScene: event.target.value })}
                />
              </label>
            </div>
            <label className={kit.field}>
              Текст вызова — что говорит заявитель
              <textarea
                rows={3}
                value={form.description}
                className={styles.grow}
                onChange={(event) => set({ description: event.target.value })}
              />
            </label>
            <label className={kit.field}>
              Теги через запятую
              <input
                value={form.tags}
                className={styles.grow}
                onChange={(event) => set({ tags: event.target.value })}
              />
            </label>
            <div className={styles.checks}>
              {(
                [
                  ["victims", "пострадавшие"],
                  ["ambulanceRefused", "отказ от скорой"],
                  ["blockedPeople", "заблокированные"],
                  ["emergency", "ЧС"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={form[key]}
                    onChange={(event) => set({ [key]: event.target.checked })}
                  />{" "}
                  {label}
                </label>
              ))}
            </div>
            <p className={kit.hint}>Осложнения:</p>
            <div className={styles.checks}>
              {(Object.keys(COMPLICATION_LABELS) as Complication[]).map(
                (key) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={form.complications.includes(key)}
                      onChange={(event) =>
                        set({
                          complications: event.target.checked
                            ? [...form.complications, key]
                            : form.complications.filter((item) => item !== key),
                          addressAsCard:
                            key === "wrong_address" && event.target.checked
                              ? false
                              : form.addressAsCard,
                        })
                      }
                    />{" "}
                    {COMPLICATION_LABELS[key]}
                  </label>
                ),
              )}
            </div>
          </Section>

          <Section title="Адрес происшествия" errors={errorsFor("address")}>
            <AddressFields
              value={form.address}
              onChange={(address) => set({ address })}
            />
          </Section>

          <Section
            title="Эталон — как правильно"
            errors={errorsFor("reference")}
          >
            <label className={kit.field}>
              Исход карточки
              <select
                value={form.outcome}
                onChange={(event) =>
                  set({ outcome: event.target.value as Outcome })
                }
              >
                {(Object.keys(OUTCOME_LABELS) as Outcome[]).map((key) => (
                  <option key={key} value={key}>
                    {OUTCOME_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <p className={kit.hint}>Службы, которые должны быть привлечены:</p>
            <div className={styles.checks}>
              {services.map((service) => (
                <label key={service.id}>
                  <input
                    type="checkbox"
                    checked={form.expectedServiceIds.includes(service.id)}
                    onChange={(event) =>
                      set({
                        expectedServiceIds: event.target.checked
                          ? [...form.expectedServiceIds, service.id]
                          : form.expectedServiceIds.filter(
                              (id) => id !== service.id,
                            ),
                      })
                    }
                  />{" "}
                  {service.name}
                  {!service.is_active && " — выключена"}
                </label>
              ))}
            </div>
            <p className={kit.hint}>Обязательно заполнить:</p>
            <div className={styles.checks}>
              {(Object.keys(REQUIRED_FIELD_LABELS) as RequiredField[]).map(
                (key) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={form.requiredFields.includes(key)}
                      onChange={(event) =>
                        set({
                          requiredFields: event.target.checked
                            ? [...form.requiredFields, key]
                            : form.requiredFields.filter(
                                (item) => item !== key,
                              ),
                        })
                      }
                    />{" "}
                    {REQUIRED_FIELD_LABELS[key]}
                  </label>
                ),
              )}
            </div>
            <label className={styles.inline}>
              <input
                type="checkbox"
                checked={form.addressAsCard}
                onChange={(event) =>
                  set({
                    addressAsCard: event.target.checked,
                    expectedAddress: event.target.checked
                      ? form.expectedAddress
                      : { ...form.address },
                  })
                }
              />{" "}
              правильный адрес совпадает с адресом в вызове
            </label>
            {!form.addressAsCard && (
              <>
                <p className={kit.hint}>
                  Правильный адрес — его диспетчер должен выяснить и записать:
                </p>
                <AddressFields
                  value={form.expectedAddress}
                  onChange={(expectedAddress) => set({ expectedAddress })}
                />
              </>
            )}
            <label className={kit.field}>
              Комментарий по смыслу — с ним сравнивается доклад
              <textarea
                rows={2}
                value={form.expectedComment}
                className={styles.grow}
                onChange={(event) =>
                  set({ expectedComment: event.target.value })
                }
              />
            </label>
            {!form.expectedComment.trim() && (
              <button
                type="button"
                className={kit.plain}
                onClick={() =>
                  set({ expectedComment: suggestComment(form, serviceName) })
                }
              >
                Подставить заготовку
              </button>
            )}
            <label className={kit.field}>
              Ключевые слова комментария — через запятую, варианты через «/»
              <input
                value={form.commentKeywords}
                placeholder="например: утечка / запах газа, эвакуация"
                maxLength={600}
                onChange={(event) =>
                  set({ commentKeywords: event.target.value })
                }
              />
            </label>
            <p className={kit.hint}>
              Адрес, суть происшествия, решение и пострадавших система ищет в
              комментарии сама. Здесь — то, что важно именно в этом сценарии.
            </p>
          </Section>

          <Section title="Звонок в службу" errors={errorsFor("call")}>
            <label className={styles.inline}>
              <input
                type="checkbox"
                checked={form.callRequired}
                onChange={(event) =>
                  set({ callRequired: event.target.checked })
                }
              />{" "}
              звонок обязателен
            </label>
            {form.callRequired && (
              <div className={kit.actions}>
                <label className={kit.field}>
                  Куда звонить
                  <select
                    value={form.callServiceId}
                    onChange={(event) =>
                      set({ callServiceId: event.target.value })
                    }
                  >
                    <option value="">— выберите —</option>
                    {services.map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name} (доб. {service.phone_ext})
                        {!service.is_active && " — выключена"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={kit.field}>
                  Не позднее, с
                  <input
                    type="number"
                    min={1}
                    value={form.callBeforeS}
                    className={kit.number}
                    onChange={(event) =>
                      set({ callBeforeS: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
            )}
          </Section>

          <Section title="Для себя" errors={[]}>
            <label className={kit.field}>
              Комментарий преподавателя к сценарию
              <textarea
                rows={2}
                value={form.teacherComment}
                className={styles.grow}
                onChange={(event) =>
                  set({ teacherComment: event.target.value })
                }
              />
            </label>
          </Section>
        </fieldset>

        <ScenarioPreview form={form} serviceName={serviceName} />
      </div>
    </section>
  );
}

function serviceForTypeCode(
  types: { code: string; main_service_code: string }[],
  code: string,
): string {
  const type = types.find((item) => item.code === code);
  return type ? serviceForType(type) : "";
}

function Section({
  title,
  errors,
  children,
}: {
  title: string;
  errors: string[];
  children: React.ReactNode;
}) {
  return (
    <div className={errors.length ? styles.sectionError : styles.section}>
      <h3 className={kit.panelTitle}>{title}</h3>
      <Errors list={errors} />
      {children}
    </div>
  );
}

function Errors({ list }: { list: string[] }) {
  if (list.length === 0) return null;
  return (
    <ul className={kit.problems} role="alert">
      {list.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

function AddressFields({
  value,
  onChange,
}: {
  value: Address;
  onChange: (next: Address) => void;
}) {
  return (
    <div className={kit.actions}>
      {ADDRESS_FIELDS.map(([key, label]) => (
        <label key={key} className={kit.field}>
          {label}
          <input
            value={value[key] ?? EMPTY_ADDRESS[key]}
            className={key === "street" ? styles.street : styles.short}
            onChange={(event) =>
              onChange({ ...value, [key]: event.target.value })
            }
          />
        </label>
      ))}
    </div>
  );
}
