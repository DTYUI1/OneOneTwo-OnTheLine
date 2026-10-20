import { FieldCaption, FieldHelp } from "../../shared/FieldHelp";
// Создание занятия: состав по рабочим местам со службой и уровнем.
// Служба задаётся здесь, а не берётся из учётки: преподаватель может посадить
// обучаемого за другую ДДС (ответ капитана 22.09 §1).
// Нормативы и критерии оценки — снимок этого занятия: тайминг и критерии успешности
// настраивает преподаватель (ТЗ), не меняя значения класса и занятия коллег.
import { useEffect, useRef, useState } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import { SettingsFields } from "../../admin/SettingsForm";
import { formatHandlingNormative } from "../../shared/handlingNormative";
import { TraineeInput } from "./TraineeInput";
import { ThemeSelection, type Category } from "./ThemeSelection";
import { AIResourceDialog } from "./AIResourceDialog";
import {
  settingsChanged,
  validateSettings,
  type Settings,
} from "../../admin/adminModel";
import {
  MAX_LEVEL,
  MAX_WORKSTATION,
  validateParticipants,
  type ParticipantDraft,
} from "./model";
import styles from "./Console.module.css";
import { isDdsService } from "../../shared/services";
import {
  contactListProblems,
  PhoneContacts,
  type ContactLists,
} from "./PhoneContacts";

export function SessionForm({
  onCreated,
  prefill = null,
}: {
  onCreated: (id: string) => void;
  /** Подтверждённая рекомендация из отчёта: обучаемый и уровень следующего занятия. */
  prefill?: { userId: string; level: number } | null;
}) {
  const queries = useQueryClient();
  const [title, setTitle] = useState(
    "Занятие " + new Date().toLocaleDateString("ru-RU"),
  );
  const [draft, setDraft] = useState<
    (Omit<ParticipantDraft, "level"> & { level: number | null })[]
  >([]);
  const [error, setError] = useState("");
  // null — ещё не правили: берутся значения класса.
  const [own, setOwn] = useState<Settings | null>(null);
  // Параллельная работа (Q11): сколько карточек одновременно; null — как в настройках.
  const [parallel, setParallel] = useState<number | null>(null);
  // Абоненты телефона ДДС (GP-09): только списки, которые правил преподаватель.
  const [contacts, setContacts] = useState<ContactLists>({});
  const [categories, setCategories] = useState<Category[]>([]);
  const [aiSelection, setAiSelection] = useState(false);
  const [cardsPerParticipant, setCardsPerParticipant] = useState(1);
  const [warning, setWarning] = useState(false);
  const [checking, setChecking] = useState(false);
  const aiRequest = useRef<{ signature: string; id: string } | null>(null);
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => (await api.GET("/health")).data ?? null,
  });

  const users = useQuery({
    queryKey: ["users"],
    queryFn: async () => {
      const { data, error } = await api.GET("/users");
      if (!data)
        throw new Error(
          error?.message ?? "Не удалось загрузить пользователей.",
        );
      return data;
    },
  });
  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const { data } = await api.GET("/services");
      return data ?? [];
    },
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data } = await api.GET("/settings");
      return data ?? null;
    },
  });

  // Заблокированного администратором сервер в занятие не пустит (422) — не предлагаем.
  const trainees = (users.data ?? []).filter(
    (user) => user.role === "trainee" && user.is_active,
  );

  // Рекомендацию из отчёта подставляем один раз, когда загрузились учётки;
  // дальше форму правит преподаватель.
  useEffect(() => {
    if (!prefill || !users.data) return;
    const user = users.data.find((item) => item.id === prefill.userId);
    if (!user) return;
    setDraft((current) =>
      current.length > 0
        ? current
        : [
            {
              user_id: user.id,
              workstation_number: user.workstation_number ?? 1,
              dds_service_id: user.dds_service_id ?? "",
              level: prefill.level,
            },
          ],
    );
  }, [prefill, users.data]);
  const snapshot = own ?? settings.data ?? null;
  const normsChanged =
    own !== null && settings.data ? settingsChanged(own, settings.data) : false;
  const normProblems = snapshot ? validateSettings(snapshot) : [];
  const ddsIds = [
    ...new Set(draft.map((item) => item.dds_service_id).filter(Boolean)),
  ];
  // Списки ДДС, которых в составе больше нет, не сохраняются.
  const ownContacts = Object.fromEntries(
    Object.entries(contacts).filter(([id]) => ddsIds.includes(id)),
  );
  // Названия ДДС для подписей: в интерфейсе — «ЖКХ», а не идентификатор `GKH`.
  const serviceNames = Object.fromEntries(
    (services.data ?? []).map((service) => [service.id, service.name]),
  );
  const recommendations = useQueries({
    queries: draft.map((item) => {
      const user = trainees.find((each) => each.id === item.user_id);
      return {
        queryKey: [
          "generation-trainees",
          user?.login ?? "",
          item.dds_service_id,
        ],
        enabled: Boolean(user && item.dds_service_id),
        queryFn: async () => {
          const { data, error } = await api.GET("/packs/generation-trainees", {
            params: {
              query: { login: user!.login, service_id: item.dds_service_id },
            },
          });
          if (!data)
            throw new Error(error?.message ?? "Рекомендация недоступна.");
          return data;
        },
      };
    }),
  });
  const recommendedLevels = draft.map(
    (item, index) =>
      recommendations[index]?.data?.find((user) => user.id === item.user_id)
        ?.recommended_level ?? 1,
  );
  const participants: ParticipantDraft[] = draft.map((item, index) => ({
    ...item,
    level: item.level ?? recommendedLevels[index],
  }));
  const waitingForLevels = draft.some(
    (item, index) =>
      item.user_id && item.level === null && recommendations[index]?.isPending,
  );
  const problems = [
    ...validateParticipants(participants),
    ...normProblems,
    ...contactListProblems(ownContacts, serviceNames),
  ];

  const create = useMutation({
    mutationFn: async (generation_policy: "after_lessons" | "now") => {
      if (!snapshot) throw new Error("Настройки занятия ещё не загружены.");
      const body = {
        title,
        participants,
        settings_snapshot: {
          ...snapshot,
          parallel_cards: parallel ?? snapshot.parallel_cards,
          // Списки абонентов в форме неизменяемые, в контракте — обычные массивы.
          phone_contacts: {
            ...(snapshot.phone_contacts ?? {}),
            ...(ownContacts as NonNullable<Settings["phone_contacts"]>),
          },
        },
      };
      const signature = JSON.stringify({
        ...body,
        cardsPerParticipant,
        categories,
        generation_policy,
      });
      if (!aiRequest.current || aiRequest.current.signature !== signature) {
        aiRequest.current = { signature, id: crypto.randomUUID() };
      }
      const { data, error } = await api.POST("/sessions", {
        params: { header: { "X-CSRF-Token": csrfToken() } },
        body: {
          ...body,
          ...(aiSelection
            ? {
                ai_selection: {
                  request_id: aiRequest.current.id,
                  cards_per_participant: cardsPerParticipant,
                  generation_policy,
                  categories,
                },
              }
            : {}),
        },
      });
      if (!data)
        throw new Error(error?.message ?? "Не удалось создать занятие.");
      return data;
    },
    onSuccess: async (session) => {
      setDraft([]);
      setOwn(null);
      setContacts({});
      setError("");
      aiRequest.current = null;
      await queries.invalidateQueries({ queryKey: ["sessions"] });
      onCreated(session.id);
    },
    onError: (cause: Error) => setError(cause.message),
  });

  async function requestCreate() {
    if (!aiSelection) {
      create.mutate("after_lessons");
      return;
    }
    setChecking(true);
    setError("");
    try {
      const { data, error } = await api.GET("/ai/resource");
      if (!data)
        throw new Error(error?.message ?? "Не удалось проверить состояние ИИ.");
      if (data.local_ai && data.lesson_running) setWarning(true);
      else create.mutate("after_lessons");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось проверить состояние ИИ.",
      );
    } finally {
      setChecking(false);
    }
  }

  function addParticipant() {
    const used = new Set(draft.map((item) => item.workstation_number));
    let place = 1;
    while (used.has(place) && place < MAX_WORKSTATION) place += 1;
    // Обучаемого преподаватель выбирает сам: строка приходит пустой, а АРМ и служба
    // подставятся из профиля, когда он будет выбран (chooseTrainee).
    setDraft([
      ...draft,
      {
        user_id: "",
        workstation_number: place,
        dds_service_id:
          services.data?.find(
            (service) => service.is_active && isDdsService(service),
          )?.id ?? "",
        level: null,
      },
    ]);
  }

  function chooseTrainee(index: number, userId: string) {
    const user = trainees.find((item) => item.id === userId);
    // Профиль только предзаполняет форму — дальше решает преподаватель.
    update(index, {
      user_id: userId,
      ...(draft[index]?.user_id !== userId ? { level: null } : {}),
      ...(user?.workstation_number
        ? { workstation_number: user.workstation_number }
        : {}),
      ...(user?.dds_service_id ? { dds_service_id: user.dds_service_id } : {}),
    });
  }

  function update(index: number, patch: Partial<(typeof draft)[number]>) {
    setDraft((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }

  return (
    <section className={styles.view} aria-labelledby="new-session">
      {warning && (
        <AIResourceDialog
          action="generate"
          onChoose={(choice) => {
            setWarning(false);
            if (choice !== "cancel")
              create.mutate(choice === "now" ? "now" : "after_lessons");
          }}
        />
      )}
      <header className={styles.titleBar}>
        <div>
          <h2 id="new-session">Новое занятие</h2>
        </div>
      </header>
      <div className={styles.tabBody}>
        <div className={styles.panel}>
          <label className={styles.field}>
            Название
            <input
              value={title}
              className={styles.wide}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <input
              type="checkbox"
              checked={aiSelection}
              disabled={health.data?.ai_provider !== "local"}
              onChange={(event) => setAiSelection(event.target.checked)}
            />
            ИИ подбирает задания
          </label>
          {aiSelection ? (
            <>
              <label className={styles.field}>
                Карточек каждому
                <select
                  value={cardsPerParticipant}
                  onChange={(event) =>
                    setCardsPerParticipant(Number(event.target.value))
                  }
                >
                  {[1, 2, 3, 4].map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </label>
              <ThemeSelection
                value={categories}
                onChange={setCategories}
                disabled={checking || warning || create.isPending}
              />
              <p className={styles.hint}>
                Система учтёт службу и оценённые попытки каждого обучаемого,
                подготовит и проверит весь набор, затем назначит задания. Начать
                занятие можно после подготовки.
              </p>
            </>
          ) : (
            health.data?.ai_provider !== "local" && (
              <p className={styles.hint}>
                Локальный ИИ выключен. Доступно занятие на готовых сценариях.
              </p>
            )
          )}
          <label className={styles.field}>
            <FieldCaption
              label="Карточек одновременно у обучаемого"
              help="Сколько незавершённых карточек можно выдать одному обучаемому одновременно. Число также ограничено его уровнем."
            />
            <select
              aria-label="Карточек одновременно у обучаемого"
              value={parallel ?? settings.data?.parallel_cards ?? 1}
              onChange={(event) => setParallel(Number(event.target.value))}
            >
              <option value={1}>1 — по очереди</option>
              <option value={2}>2 — параллельно</option>
              <option value={3}>3 — параллельно</option>
            </select>
          </label>
          <p className={styles.hint}>
            Не больше уровня обучаемого: на уровне 1 карточки всегда идут по
            очереди. В параллельном режиме задайте при раздаче задержки,
            например 0, 45 и 90 с после старта, — новая карточка придёт, пока
            обучаемый работает с прежней. Обучаемого предупредят об этом при
            входе.
          </p>
        </div>

        {snapshot && (
          <details className={styles.panel}>
            <summary className={styles.panelTitle}>
              Нормативы и оценка занятия ·{" "}
              {normsChanged
                ? "изменены для этого занятия"
                : "как в настройках класса"}
            </summary>
            <p className={styles.hint}>
              Реакция {snapshot.reaction_normative_s} с, отработка{" "}
              {formatHandlingNormative(snapshot.handling_normative_s)}. Значения
              действуют только на это занятие; настройки класса и занятия коллег
              не меняются.
            </p>
            <SettingsFields
              value={snapshot}
              onChange={(patch) => setOwn({ ...snapshot, ...patch })}
              weightHint="Вес — насколько критерий влияет на итог этого занятия; 0 исключает критерий. Потолок — выше какого балла карточка не поднимется при критической ошибке. Штраф за доклад вариантом уменьшает балл за содержание доклада по сравнению с голосом: 0 % — без снижения, 100 % — содержание не засчитывается."
            />
            {normsChanged && (
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.plain}
                  onClick={() => setOwn(null)}
                >
                  Вернуть настройки класса
                </button>
              </div>
            )}
          </details>
        )}

        <PhoneContacts
          serviceIds={ddsIds}
          names={serviceNames}
          lists={ownContacts}
          onChange={setContacts}
        />

        <div className={styles.panel}>
          <h3 id="session-participants" className={styles.panelTitle}>
            Состав по рабочим местам
          </h3>
          <div
            className={styles.tableScroll}
            role="region"
            aria-labelledby="session-participants"
            tabIndex={0}
          >
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Обучаемый</th>
                  <th>АРМ</th>
                  <th>
                    ДДС на занятии{" "}
                    <FieldHelp label="Служба на занятии">
                      Служба, от имени которой обучаемый работает на этом
                      занятии. Может отличаться от службы в его учётной записи.
                    </FieldHelp>
                  </th>
                  <th>
                    Уровень{" "}
                    <FieldHelp label="Уровень обучаемого">
                      Сложность заданий и ограничение числа одновременных
                      карточек. Оставьте поле пустым, чтобы использовать
                      рекомендуемый уровень.
                    </FieldHelp>
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {draft.length === 0 && (
                  <tr>
                    <td colSpan={5} className={styles.muted}>
                      Добавьте рабочее место: обучаемый, номер АРМ, служба и
                      уровень.
                    </td>
                  </tr>
                )}
                {draft.map((item, index) => (
                  <tr key={index}>
                    <td>
                      <TraineeInput
                        value={item.user_id}
                        trainees={trainees}
                        usedIds={draft.map((row) => row.user_id)}
                        onChange={(userId) => chooseTrainee(index, userId)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        max={MAX_WORKSTATION}
                        value={item.workstation_number}
                        aria-label="Номер АРМ"
                        className={styles.number}
                        onChange={(event) =>
                          update(index, {
                            workstation_number: Number(event.target.value),
                          })
                        }
                      />
                    </td>
                    <td>
                      <select
                        value={item.dds_service_id}
                        aria-label="Служба ДДС"
                        onChange={(event) =>
                          update(index, { dds_service_id: event.target.value })
                        }
                      >
                        {(services.data ?? [])
                          // Выключенная служба в новое занятие не попадёт (422).
                          .filter(
                            (service) =>
                              (service.is_active && isDdsService(service)) ||
                              service.id === item.dds_service_id,
                          )
                          .map((service) => (
                            <option key={service.id} value={service.id}>
                              {service.name}
                              {!service.is_active && " — выключена"}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        min={1}
                        max={MAX_LEVEL}
                        value={item.level ?? ""}
                        placeholder={String(recommendedLevels[index])}
                        aria-label="Уровень сложности"
                        aria-describedby={`level-hint-${index}`}
                        className={styles.number}
                        onChange={(event) =>
                          update(index, {
                            level:
                              event.target.value === ""
                                ? null
                                : Number(event.target.value),
                          })
                        }
                      />
                      <p
                        id={`level-hint-${index}`}
                        className={styles.levelHint}
                      >
                        Уровень нужен для ИИ-подбора и числа одновременных
                        карточек; вручную можно выдать карточку любого уровня.{" "}
                        Можно оставить пустым — по рекомендации:{" "}
                        {recommendedLevels[index]}.
                      </p>
                      {recommendations[index]?.isError && (
                        <p className={styles.hint}>
                          Рекомендация недоступна. По умолчанию — уровень 1;
                          можно указать другой.
                        </p>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={styles.plain}
                        onClick={() =>
                          setDraft(draft.filter((_, i) => i !== index))
                        }
                      >
                        Убрать
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.plain}
              onClick={addParticipant}
              disabled={users.isPending}
            >
              Добавить рабочее место
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={
                problems.length > 0 ||
                waitingForLevels ||
                create.isPending ||
                checking ||
                warning ||
                !snapshot
              }
              onClick={() => void requestCreate()}
            >
              Создать занятие
            </button>
          </div>

          {(draft.length > 0 || normProblems.length > 0) &&
            problems.length > 0 && (
              <ul className={styles.problems} role="status">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            )}
          {error && <p role="alert">{error}</p>}
          <p className={styles.hint}>
            Обучаемого найдите по ФИО или логину: при вводе появятся подсказки,
            номер рабочего места и служба подставятся из его учётной записи.
            Действует меньшее из уровня и настройки «Параллельных карточек».
          </p>
          <p className={styles.hint}>
            Следующий шаг — сценарии для каждого места: они откроются сразу
            после «Создать занятие», под ними будет кнопка «Начать занятие».
          </p>
        </div>
      </div>
    </section>
  );
}
