// Создание занятия: состав по рабочим местам со службой и уровнем.
// Служба задаётся здесь, а не берётся из учётки: преподаватель может посадить
// обучаемого за другую ДДС (ответ капитана 22.09 §1).
// Нормативы и критерии оценки — снимок этого занятия: тайминг и критерии успешности
// настраивает преподаватель (ТЗ), не меняя значения класса и занятия коллег.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import { SettingsFields } from "../../admin/SettingsForm";
import { TraineeInput } from "./TraineeInput";
import { freeTrainees, traineeLabel } from "./traineeModel";
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
  type Session,
} from "./model";
import styles from "./Console.module.css";

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
  const [draft, setDraft] = useState<ParticipantDraft[]>([]);
  const [error, setError] = useState("");
  // null — ещё не правили: берутся значения класса.
  const [own, setOwn] = useState<Settings | null>(null);
  // Параллельная работа (Q11): сколько карточек одновременно; null — как в настройках.
  const [parallel, setParallel] = useState<number | null>(null);

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
  const problems = [...validateParticipants(draft), ...normProblems];

  const create = useMutation({
    mutationFn: async () => {
      if (!snapshot) throw new Error("Настройки занятия ещё не загружены.");
      const { data, error } = await api.POST("/sessions", {
        params: { header: { "X-CSRF-Token": csrfToken() } },
        body: {
          title,
          participants: draft,
          settings_snapshot: {
            ...snapshot,
            parallel_cards: parallel ?? snapshot.parallel_cards,
          },
        } as unknown as Session,
      });
      if (!data)
        throw new Error(error?.message ?? "Не удалось создать занятие.");
      return data;
    },
    onSuccess: async (session) => {
      setDraft([]);
      setOwn(null);
      setError("");
      await queries.invalidateQueries({ queryKey: ["sessions"] });
      onCreated(session.id);
    },
    onError: (cause: Error) => setError(cause.message),
  });

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
          services.data?.find((service) => service.is_active)?.id ?? "",
        level: 1,
      },
    ]);
  }

  function chooseTrainee(index: number, userId: string) {
    const user = trainees.find((item) => item.id === userId);
    // Профиль только предзаполняет форму — дальше решает преподаватель.
    update(index, {
      user_id: userId,
      ...(user?.workstation_number
        ? { workstation_number: user.workstation_number }
        : {}),
      ...(user?.dds_service_id ? { dds_service_id: user.dds_service_id } : {}),
    });
  }

  function update(index: number, patch: Partial<ParticipantDraft>) {
    setDraft(
      draft.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }

  return (
    <section className={styles.view} aria-labelledby="new-session">
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
            Карточек одновременно у обучаемого
            <select
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
              {snapshot.handling_normative_s} с. Значения действуют только на
              это занятие; настройки класса и занятия коллег не меняются.
            </p>
            <SettingsFields
              value={snapshot}
              onChange={(patch) => setOwn({ ...snapshot, ...patch })}
              weightHint="Вес — насколько критерий влияет на итог этого занятия; 0 исключает критерий. Потолок — выше какого балла карточка не поднимется при критической ошибке."
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
                  <th>ДДС на занятии</th>
                  <th>Уровень</th>
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
                        listId="session-trainees"
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
                              service.is_active ||
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
                        value={item.level}
                        aria-label="Уровень сложности"
                        className={styles.number}
                        onChange={(event) =>
                          update(index, { level: Number(event.target.value) })
                        }
                      />
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
            <datalist id="session-trainees">
              {freeTrainees(
                trainees,
                draft.map((item) => item.user_id),
              ).map((user) => (
                <option key={user.id} value={traineeLabel(user)} />
              ))}
            </datalist>
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
              disabled={problems.length > 0 || create.isPending || !snapshot}
              onClick={() => create.mutate()}
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
            номер АРМ и служба подставятся из его профиля. Уровень задаёт
            сложность и число одновременных карточек. Действует меньшее из
            уровня и настройки «Параллельных карточек».
          </p>
        </div>
      </div>
    </section>
  );
}
