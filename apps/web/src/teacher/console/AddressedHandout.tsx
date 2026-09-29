// Адресная выдача: у каждого места своя очередь — сценарий, задержка от старта,
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
  matchesService,
  planIssues,
  requestIdFor,
  suggestPlan,
  toBatch,
  type BatchIssue,
  type PlanItem,
} from "./handoutModel";
import { assignableScenarios, scenarioServiceIds, type Session } from "./model";
import {
  useBatchAvailability,
  useIssuedAssignments,
  useScenarios,
  useServices,
  useUsers,
} from "./useConsoleData";
import styles from "./Console.module.css";

export function AddressedHandout({ session }: { session: Session }) {
  const queries = useQueryClient();
  const assignments = useIssuedAssignments(session.id);
  const scenarios = useScenarios();
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

  const approved = assignableScenarios(scenarios.data ?? []);
  const scenarioById = (id: string) => approved.find((item) => item.id === id);
  const fullName = (id: string) =>
    users.data?.find((user) => user.id === id)?.full_name ?? "…";
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
          new Error(failure?.message ?? "Пачка не принята."),
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
        setError("Пачка не принята целиком: исправьте отмеченные строки.");
        return;
      }
      setError(
        cause.status === undefined
          ? "Ответ сервера не дошёл. Нажмите «Выдать пачкой» ещё раз. Повторная отправка не создаст дубликатов заданий."
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
        <h3 className={styles.panelTitle}>Адресная выдача</h3>
        <p className={styles.hint}>
          Разные задания и задержки каждому месту одной пачкой — сервер пока эту
          выдачу не принимает. До её включения работает раздача по службам ниже.
        </p>
      </div>
    );

  const hasProblems = [...localIssues.values()].some((list) => list.length > 0);

  return (
    <div className={styles.panel}>
      <h3 className={styles.panelTitle}>Адресная выдача</h3>
      <p className={styles.hint}>
        У каждого места своя очередь. Задержка считается от старта занятия.
        Задание чужой службы уходит только как отмеченное упражнение на неверную
        доставку.
      </p>
      <div className={styles.actions}>
        <label className={styles.field}>
          Первое через, с
          <input
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
          Интервал, с
          <input
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
          onClick={() =>
            change(
              suggestPlan(session.participants, approved, timing, () =>
                crypto.randomUUID(),
              ),
            )
          }
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
                        <td>
                          <span className={styles.chip}>
                            {scenario
                              ? scenarioServiceIds(scenario)
                                  .map(serviceName)
                                  .join(", ")
                              : "—"}
                          </span>{" "}
                          {scenario
                            ? `№ ${scenario.card.number} · ${scenario.card.incident_class}`
                            : "сценарий недоступен"}{" "}
                          · ур. {scenario?.level}
                          {problems.length > 0 && (
                            <ul className={styles.problems} role="alert">
                              {problems.map((message) => (
                                <li key={message}>{message}</li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td>
                          <label className={styles.field}>
                            через, с
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
                          </label>
                        </td>
                        <td>
                          {item.mode === "profile" ? (
                            <span className={styles.muted}>своя служба</span>
                          ) : (
                            <span className={styles.exercise}>
                              упражнение: чужая служба
                            </span>
                          )}
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
            <label className={styles.field}>
              Добавить задание
              <select
                value=""
                onChange={(event) => {
                  const scenario = scenarioById(event.target.value);
                  if (scenario)
                    change(
                      addItem(
                        plan,
                        participant,
                        scenario,
                        timing,
                        crypto.randomUUID(),
                      ),
                    );
                }}
              >
                <option value="">— выберите сценарий —</option>
                <optgroup label="Своя служба">
                  {approved
                    .filter((scenario) => matchesService(scenario, participant))
                    .map((scenario) => (
                      <option key={scenario.id} value={scenario.id}>
                        № {scenario.card.number} ·{" "}
                        {scenario.card.incident_class}
                        {" · ур. "}
                        {scenario.level}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="Чужая служба — упражнение на неверную доставку">
                  {approved
                    .filter(
                      (scenario) => !matchesService(scenario, participant),
                    )
                    .map((scenario) => (
                      <option key={scenario.id} value={scenario.id}>
                        № {scenario.card.number} ·{" "}
                        {scenario.card.incident_class} ·{" "}
                        {serviceName(scenario.target_service_id)} · ур.{" "}
                        {scenario.level}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
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
            send.isPending
          }
          onClick={() => send.mutate()}
        >
          {send.isPending ? "Отправляем…" : `Выдать пачкой (${plan.length})`}
        </button>
        {plan.length > MAX_BATCH && (
          <span className={styles.hint}>
            В одной пачке не больше {MAX_BATCH} заданий.
          </span>
        )}
      </div>
    </div>
  );
}
