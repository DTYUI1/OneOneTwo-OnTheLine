import { AssignmentScenarioPicker } from "./AssignmentScenarioPicker";
import { FieldCaption } from "../../shared/FieldHelp";
// Задания по рабочим местам: у каждого места своя очередь — сценарий, задержка от старта,
// режим доставки. Уходит одной пачкой; пока сервер пачки не принимает (501),
// честно говорим об этом и не имитируем её серией одиночных запросов.
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import {
  MAX_BATCH,
  addItem,
  formatDelay,
  issuesFromServer,
  planIssues,
  requestIdFor,
  suggestPlan,
  toBatch,
  type BatchIssue,
  type PlanItem,
} from "./handoutModel";
import { scenarioServiceIds, type Session } from "./model";
import { catalogScenarios } from "./handoutCatalog";
import {
  useBatchAvailability,
  useIssuedAssignments,
  useHandoutCatalog,
  usePlayableScenarios,
  useScenarios,
  useServices,
  useUsers,
} from "./useConsoleData";
import styles from "./Console.module.css";
import { SessionNorms } from "./SessionNorms";
import { StartButton, StartStatus, type StartControl } from "./StartLesson";

export function AddressedHandout({
  session,
  start,
}: {
  session: Session;
  /** «Начать занятие» — рядом с «Выдать задания». */
  start?: StartControl;
}) {
  const queries = useQueryClient();
  const assignments = useIssuedAssignments(session.id);
  const scenarios = useScenarios();
  const catalog = useHandoutCatalog();
  const playable = usePlayableScenarios();
  const users = useUsers();
  const { serviceName } = useServices();
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [timing, setTiming] = useState({ firstDelayS: 10, intervalS: 60 });
  const [serverIssues, setServerIssues] = useState<Map<string, string[]>>(
    new Map(),
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lastAttempt = useRef<{ body: string; requestId: string } | null>(null);

  const capability = useBatchAvailability(session.id);
  const available = capability.available;

  const approved = catalogScenarios(catalog.data ?? [], scenarios.data ?? []);
  const scenarioById = (id: string) => approved.find((item) => item.id === id);
  const catalogPending = catalog.isPending || scenarios.isPending;
  const catalogError = catalog.error ?? scenarios.error;
  const catalogBlocked =
    catalogPending ||
    Boolean(catalogError) ||
    catalog.isFetching ||
    scenarios.isFetching;
  // Выбранное не удаляем при обновлении каталога: преподаватель решает сам.
  const unavailablePlan = plan.some((item) => !scenarioById(item.scenarioId));
  const fullName = (id: string) =>
    users.data?.find((user) => user.id === id)?.full_name ?? "…";
  // Подпись места — про план; выданное уже не в плане, но «нет заданий» о нём неправда.
  const issuedTo = (id: string) =>
    (assignments.data ?? []).filter((item) => item.participant_id === id)
      .length;
  const localIssues = planIssues(plan);
  const issuesFor = (key: string) => [
    ...(localIssues.get(key) ?? []),
    ...(serverIssues.get(key) ?? []),
  ];

  const change = (next: PlanItem[]) => {
    setPlan(next);
    setServerIssues(new Map());
    setError("");
    setNotice("");
  };

  const send = useMutation({
    mutationFn: async () => {
      if (catalogBlocked || unavailablePlan)
        throw Object.assign(
          new Error("Проверьте доступность выбранных сценариев."),
          { status: 422 },
        );
      const { items } = toBatch(plan, assignments.data ?? [], "");
      const body = { items };
      const attempt = requestIdFor(body, lastAttempt.current, () =>
        crypto.randomUUID(),
      );
      lastAttempt.current = attempt;
      const result = await api.POST("/sessions/{id}/assignments/batch", {
        params: {
          path: { id: session.id },
          header: { "X-CSRF-Token": csrfToken() },
        },
        body: { ...body, request_id: attempt.requestId },
      });
      if (!result.data) {
        const failure = result.error as {
          message?: string;
          details?: { items?: BatchIssue[] };
        };
        throw Object.assign(
          new Error(failure?.message ?? "Не удалось выдать задания."),
          {
            status: result.response.status,
            items: failure?.details?.items ?? [],
          },
        );
      }
      return result.data;
    },
    onSuccess: async (batch) => {
      setPlan([]);
      lastAttempt.current = null;
      setNotice(
        `Выдано заданий: ${batch.assignments.length}. Повторная отправка этого набора не создаст дубликатов.`,
      );
      await queries.invalidateQueries({
        queryKey: ["assignments", session.id],
      });
      // Задания пачек C-03 отдаёт только в списке пачек — его тоже перечитываем.
      await queries.invalidateQueries({
        queryKey: ["assignment-batches", session.id],
      });
    },
    onError: (cause: Error & { status?: number; items?: BatchIssue[] }) => {
      if (cause.status === 422 && cause.items?.length) {
        setServerIssues(issuesFromServer(plan, cause.items));
        setError("Задания не выданы: исправьте отмеченные строки.");
        return;
      }
      setError(
        cause.status === undefined
          ? "Ответ сервера не дошёл. Нажмите «Выдать задания» ещё раз. Повторная отправка не создаст дубликатов заданий."
          : cause.status === 409
            ? `${cause.message} Обновите страницу, чтобы увидеть уже выданное.`
            : cause.message,
      );
    },
  });

  if (capability.pending) return null;
  if (!available)
    return (
      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Задания по рабочим местам</h3>
        <p className={styles.hint}>
          Выдача отдельных заданий каждому рабочему месту пока недоступна.
          Используйте раздачу по службам ниже.
        </p>
      </div>
    );

  const hasProblems = [...localIssues.values()].some((list) => list.length > 0);

  return (
    <div className={styles.panel}>
      <h3 className={styles.panelTitle}>Задания по рабочим местам</h3>
      <p className={styles.hint}>
        У каждого места своя очередь. Задержка считается от старта занятия.
        Задание чужой службы уходит только как отмеченное упражнение на неверную
        доставку.
      </p>
      <SessionNorms key={session.id} session={session} />
      {catalogPending && <p role="status">Загружаем сценарии…</p>}
      {catalogError && (
        <div role="alert">
          <p>{catalogError.message}</p>
          <button
            type="button"
            className={styles.plain}
            disabled={catalog.isFetching || scenarios.isFetching}
            onClick={() => {
              void catalog.refetch();
              void scenarios.refetch();
            }}
          >
            Повторить загрузку сценариев
          </button>
        </div>
      )}
      {!catalogBlocked && approved.length === 0 && (
        <p>В общем каталоге нет доступных сценариев.</p>
      )}
      {!catalogBlocked && unavailablePlan && (
        <p role="alert">
          Часть выбранных сценариев недоступна. Уберите эти задания из плана или
          повторите загрузку позже.
        </p>
      )}
      {playable.isError && (
        <p role="alert">
          Автоматический подбор недоступен: {playable.error.message} Добавьте
          задания вручную.
        </p>
      )}
      <div className={styles.actions}>
        <label className={styles.field}>
          <FieldCaption
            label="Первое через, с"
            help="Через сколько секунд от начала занятия появится первое задание. Задержки остальных заданий можно изменить ниже."
          />
          <input
            aria-label="Первое через, с"
            type="number"
            min={0}
            value={timing.firstDelayS}
            className={styles.number}
            onChange={(event) =>
              setTiming({ ...timing, firstDelayS: Number(event.target.value) })
            }
          />
        </label>
        <label className={styles.field}>
          <FieldCaption
            label="Интервал, с"
            help="Промежуток между заданиями одного рабочего места при автоматическом подборе, в секундах."
          />
          <input
            aria-label="Интервал, с"
            type="number"
            min={0}
            value={timing.intervalS}
            className={styles.number}
            onChange={(event) =>
              setTiming({ ...timing, intervalS: Number(event.target.value) })
            }
          />
        </label>
        <button
          type="button"
          className={styles.plain}
          // Пока список не пришёл, подбор молча дал бы пустой план.
          disabled={
            catalogBlocked ||
            playable.isPending ||
            playable.isError ||
            playable.isFetching
          }
          onClick={() => {
            const next = suggestPlan(
              session.participants,
              approved,
              playable.data ?? new Set(),
              timing,
              () => crypto.randomUUID(),
            );
            change(next);
            if (next.length === 0)
              setNotice(
                "Готовых сценариев службы и уровня этих мест нет. Добавьте задания вручную.",
              );
          }}
        >
          Подобрать по службе и уровню
        </button>
        {plan.length > 0 && (
          <button
            type="button"
            className={styles.plain}
            onClick={() => change([])}
          >
            Очистить план
          </button>
        )}
      </div>

      {session.participants.map((participant) => {
        const queue = plan.filter(
          (item) => item.participantId === participant.user_id,
        );
        return (
          <div key={participant.user_id} className={styles.seatPlan}>
            <div className={styles.seatHead}>
              <strong>АРМ {participant.workstation_number}</strong>
              <span>{fullName(participant.user_id)}</span>
              <span className={styles.chip}>
                {serviceName(participant.dds_service_id)}
              </span>
              <span>уровень {participant.level}</span>
              <span className={styles.muted}>
                {queue.length
                  ? `${queue.length} зад.: ${queue.map((item) => formatDelay(item.delayS)).join(", ")}`
                  : issuedTo(participant.user_id)
                    ? `выдано: ${issuedTo(participant.user_id)}`
                    : "нет заданий"}
              </span>
            </div>
            {queue.length > 0 && (
              <table className={styles.table}>
                <tbody>
                  {queue.map((item, index) => {
                    const scenario = scenarioById(item.scenarioId);
                    const problems = issuesFor(item.key);
                    return (
                      <tr key={item.key}>
                        <td className={styles.seat}>{index + 1}</td>
                        <td className={styles.seatScenario}>
                          <span className={styles.chip}>
                            {scenario
                              ? scenarioServiceIds(scenario)
                                  .map(serviceName)
                                  .join(", ")
                              : "—"}
                          </span>{" "}
                          {scenario
                            ? scenario.displayTitle
                            : "сценарий недоступен"}{" "}
                          · ур. {scenario?.level}
                          {scenario?.specifics && (
                            <span className={styles.deliveryNote}>
                              {scenario.specifics}
                            </span>
                          )}
                          <span className={styles.deliveryNote}>
                            {item.mode === "profile" ? (
                              <span className={styles.muted}>своя служба</span>
                            ) : (
                              <span className={styles.exercise}>
                                упражнение: чужая служба
                              </span>
                            )}
                          </span>
                          {problems.length > 0 && (
                            <ul className={styles.problems} role="alert">
                              {problems.map((message) => (
                                <li key={message}>{message}</li>
                              ))}
                            </ul>
                          )}
                          <div className={styles.assignmentControls}>
                            <label
                              className={`${styles.field} ${styles.assignmentDelay}`}
                            >
                              через
                              <input
                                type="number"
                                min={0}
                                value={item.delayS}
                                className={styles.number}
                                onChange={(event) =>
                                  change(
                                    plan.map((row) =>
                                      row.key === item.key
                                        ? {
                                            ...row,
                                            delayS: Number(event.target.value),
                                          }
                                        : row,
                                    ),
                                  )
                                }
                              />
                              сек
                            </label>
                          </div>
                        </td>
                        <td>
                          <button
                            type="button"
                            className={styles.plain}
                            aria-label="Убрать задание"
                            onClick={() =>
                              change(plan.filter((row) => row.key !== item.key))
                            }
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <AssignmentScenarioPicker
              scenarios={approved}
              disabled={catalogBlocked}
              participant={participant}
              serviceName={serviceName}
              onChoose={(scenario) =>
                change(
                  addItem(
                    plan,
                    participant,
                    scenario,
                    timing,
                    crypto.randomUUID(),
                  ),
                )
              }
            />
          </div>
        );
      })}

      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          disabled={
            plan.length === 0 ||
            plan.length > MAX_BATCH ||
            hasProblems ||
            catalogBlocked ||
            unavailablePlan ||
            send.isPending
          }
          onClick={() => send.mutate()}
        >
          {send.isPending ? "Отправляем…" : `Выдать задания (${plan.length})`}
        </button>
        {start && <StartButton start={start} />}
        {plan.length > MAX_BATCH && (
          <span className={styles.hint}>
            За один раз можно выдать не больше {MAX_BATCH} заданий.
          </span>
        )}
      </div>
      {start && <StartStatus start={start} />}
    </div>
  );
}
