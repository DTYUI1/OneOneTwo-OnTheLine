// Состав занятия и раздача заданий «галочками». Сценарий уходит только своей
// службе; что и кому уйдёт, видно до нажатия.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import {
  distribute,
  ordersByParticipant,
  planAssignments,
  scenarioServiceIds,
  type Assignment,
  type Session,
} from "./model";
import {
  type IssuedAssignment,
  useAssignments,
  useBatchAvailability,
  useIssuedAssignments,
  useHandoutCatalog,
  useScenarios,
  useServices,
  useUsers,
} from "./useConsoleData";
import { AddressedHandout } from "./AddressedHandout";
import { catalogScenarios } from "./handoutCatalog";
import { SessionNorms } from "./SessionNorms";
import {
  StartButton,
  StartStatus,
  StartStep,
  type StartControl,
} from "./StartLesson";
import { AIPreparationPanel } from "./AIPreparationPanel";
import { SessionMaterials } from "../materials/SessionMaterials";
import styles from "./Console.module.css";

export function HandoutTab({
  session,
  start,
}: {
  session: Session;
  /** «Начать занятие» — в ряду с кнопкой выдачи; у идущего и завершённого занятия нет. */
  start?: StartControl;
}) {
  const queries = useQueryClient();
  // Одиночные назначения — для прежней раздачи; всё выданное — для счётчиков и очереди.
  const assignments = useAssignments(session.id);
  const issued = useIssuedAssignments(session.id);
  const scenarios = useScenarios();
  const catalog = useHandoutCatalog();
  const users = useUsers();
  const { serviceName } = useServices();
  const [checked, setChecked] = useState<string[]>([]);
  const [firstDelayS, setFirstDelayS] = useState(10);
  const [intervalS, setIntervalS] = useState(60);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Сервер меняет задания только в черновике (409). Не даём преподавателю
  // отметить сценарии и узнать об этом уже из ошибки.
  const draft = session.status === "draft" && !session.ai_preparation;
  // Когда сервер принимает пачку, остаётся только адресная выдача: серия
  // одиночных запросов пачку не заменяет (I-SESSION).
  const batch = useBatchAvailability(session.id);
  const approved = catalogScenarios(catalog.data ?? [], scenarios.data ?? []);
  const catalogPending = catalog.isPending || scenarios.isPending;
  const catalogError = catalog.error ?? scenarios.error;
  const catalogBlocked =
    catalogPending ||
    Boolean(catalogError) ||
    catalog.isFetching ||
    scenarios.isFetching;
  // Не отправляем оставшуюся часть набора, если выбранный ID исчез из каталога.
  const unavailableChecked = checked.some(
    (id) => !approved.some((item) => item.id === id),
  );
  const plan = distribute(session.participants, approved, checked);

  const assign = useMutation({
    mutationFn: async () => {
      if (catalogBlocked || unavailableChecked)
        throw new Error("Проверьте доступность выбранных сценариев.");
      const plans = planAssignments(plan.queues, {
        from: Date.now(),
        firstDelayS,
        intervalS,
      });
      // Порядок продолжает уже выданные задания: сервер хранит его на участника,
      // поэтому и считаем отдельно по каждому.
      const existing = ordersByParticipant(assignments.data ?? []);
      for (const item of plans) {
        const { error } = await api.POST("/sessions/{id}/assignments", {
          params: {
            path: { id: session.id },
            header: { "X-CSRF-Token": csrfToken() },
          },
          body: {
            ...item,
            order: item.order + (existing.get(item.participant_id) ?? 0),
          } as unknown as Assignment,
        });
        if (error) throw new Error(error.message);
      }
      return plans.length;
    },
    onSuccess: async (count) => {
      setChecked([]);
      setError("");
      setNotice(`Роздано заданий: ${count}.`);
      await queries.invalidateQueries({
        queryKey: ["assignments", session.id],
      });
    },
    onError: (cause: Error) => setError(cause.message),
    // Отдельные POST не атомарны: ошибка не отменяет уже принятые назначения.
    onSettled: () =>
      queries.invalidateQueries({ queryKey: ["assignments", session.id] }),
  });

  const fullName = (id: string) =>
    users.data?.find((user) => user.id === id)?.full_name ?? "…";
  const countFor = (id: string) =>
    issued.data.filter((item) => item.participant_id === id).length;

  return (
    <>
      {session.ai_preparation && (
        <AIPreparationPanel preparation={session.ai_preparation} />
      )}
      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Состав</h3>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>АРМ</th>
              <th>Обучаемый</th>
              <th>ДДС на занятии</th>
              <th>Уровень</th>
              <th>Заданий</th>
            </tr>
          </thead>
          <tbody>
            {session.participants.map((participant) => (
              <tr key={participant.user_id}>
                <td className={styles.seat}>
                  {participant.workstation_number}
                </td>
                <td>{fullName(participant.user_id)}</td>
                <td>{serviceName(participant.dds_service_id)}</td>
                <td>{participant.level}</td>
                <td>{countFor(participant.user_id)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!draft && (
        <div className={styles.panel}>
          <SessionNorms key={session.id} session={session} />
        </div>
      )}

      {!draft && (
        <IssuedPanel
          session={session}
          assignments={issued.data}
          scenarioTitle={(id) => {
            const scenario = (scenarios.data ?? []).find(
              (item) => item.id === id,
            );
            return scenario
              ? scenario.card.incident_class || scenario.card.description
              : "сценарий недоступен";
          }}
          fullName={fullName}
        />
      )}

      {draft && (
        <AddressedHandout
          session={session}
          start={batch.available ? start : undefined}
        />
      )}

      {draft && !batch.pending && !batch.available && (
        <div className={styles.panel}>
          <h3 className={styles.panelTitle}>Раздача по службам</h3>
          <p className={styles.hint}>
            Отмеченные сценарии выдаются по очереди тем, чья служба совпадает со
            службой происшествия. Назначать можно только утверждённые.
          </p>
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
          {unavailableChecked && !catalogBlocked && (
            <div role="alert">
              <p>
                Часть выбранных сценариев недоступна. Снимите выбор или
                повторите загрузку позже.
              </p>
              <button
                type="button"
                className={styles.plain}
                onClick={() => setChecked([])}
              >
                Снять выбор
              </button>
            </div>
          )}
          {approved.length === 0 && !catalogBlocked && (
            <p>В общем каталоге нет доступных сценариев.</p>
          )}
          {approved.length > 0 && (
            <div className={styles.scroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th aria-label="Выбор" className={styles.pick} />
                    <th>Номер</th>
                    <th>Служба</th>
                    <th>Происшествие</th>
                    <th>Уровень</th>
                    <th>Вес</th>
                  </tr>
                </thead>
                <tbody>
                  {approved.map((scenario) => {
                    const id = `pick-${scenario.id}`;
                    return (
                      <tr key={scenario.id}>
                        <td className={styles.pick}>
                          <input
                            id={id}
                            type="checkbox"
                            disabled={!draft || catalogBlocked}
                            checked={checked.includes(scenario.id)}
                            onChange={(event) =>
                              setChecked(
                                event.target.checked
                                  ? [...checked, scenario.id]
                                  : checked.filter(
                                      (item) => item !== scenario.id,
                                    ),
                              )
                            }
                          />
                        </td>
                        <td>{scenario.card.number}</td>
                        <td>
                          <span className={styles.chip}>
                            {scenarioServiceIds(scenario)
                              .map(serviceName)
                              .join(", ") || "не указана"}
                          </span>
                        </td>
                        <td>
                          <label htmlFor={id}>{scenario.displayTitle}</label>
                          {scenario.specifics && (
                            <span className={styles.deliveryNote}>
                              {scenario.specifics}
                            </span>
                          )}
                        </td>
                        <td>{scenario.level}</td>
                        <td>{scenario.weight}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {checked.length > 0 && (
            <ul className={styles.handout} role="status">
              {plan.queues.map((queue) => {
                const participant = session.participants.find(
                  (item) => item.user_id === queue.participantId,
                );
                return (
                  <li key={queue.participantId}>
                    АРМ {participant?.workstation_number} (
                    {serviceName(participant?.dds_service_id ?? "")}) —{" "}
                    {queue.scenarioIds.length} зад.
                  </li>
                );
              })}
              {plan.unmatched.map((scenario) => (
                <li key={scenario.id} className={styles.dropped}>
                  «
                  {
                    approved.find((item) => item.id === scenario.id)
                      ?.displayTitle
                  }
                  » не уйдёт: происшествие адресовано службе{" "}
                  {scenarioServiceIds(scenario).map(serviceName).join(", ")}, а
                  в составе такой нет.
                </li>
              ))}
            </ul>
          )}

          <SessionNorms key={session.id} session={session} />
          <div className={styles.actions}>
            <label className={styles.field}>
              Первая через, с
              <input
                type="number"
                min={0}
                value={firstDelayS}
                disabled={!draft}
                className={styles.number}
                onChange={(event) => setFirstDelayS(Number(event.target.value))}
              />
            </label>
            <label className={styles.field}>
              Интервал, с
              <input
                type="number"
                min={5}
                value={intervalS}
                disabled={!draft}
                className={styles.number}
                onChange={(event) => setIntervalS(Number(event.target.value))}
              />
            </label>
            <button
              type="button"
              className={styles.primary}
              disabled={
                !draft ||
                catalogBlocked ||
                unavailableChecked ||
                plan.queues.length === 0 ||
                assign.isPending
              }
              onClick={() => assign.mutate()}
            >
              Раздать отмеченные
            </button>
            {start && <StartButton start={start} />}
          </div>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {start && <StartStatus start={start} />}
        </div>
      )}
      {/* Выдачи на экране нет (задания готовит ИИ) — старт отдельным шагом. */}
      {start && !draft && <StartStep start={start} />}
      <SessionMaterials
        sessionId={session.id}
        canAssign={session.status !== "finished"}
      />
    </>
  );
}

const ASSIGNMENT_STATUS: Record<string, string> = {
  pending: "ждёт своего времени",
  delivered: "у обучаемого",
  completed: "закрыто",
  cancelled: "отменено",
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** Очередь выданных заданий: после старта преподаватель видит, что и когда придёт. */
function IssuedPanel({
  session,
  assignments,
  scenarioTitle,
  fullName,
}: {
  session: Session;
  assignments: IssuedAssignment[];
  scenarioTitle: (id: string) => string;
  fullName: (id: string) => string;
}) {
  const seat = (id: string) =>
    session.participants.find((item) => item.user_id === id)
      ?.workstation_number ?? 0;
  const rows = [...assignments].sort(
    (a, b) =>
      seat(a.participant_id) - seat(b.participant_id) || a.order - b.order,
  );
  return (
    <div className={styles.panel}>
      <h3 className={styles.panelTitle}>Выданные задания</h3>
      <p className={styles.hint}>
        {session.status === "draft"
          ? "В этом занятии задания назначаются после полной подготовки набора ИИ."
          : `Состав заданий меняется только в черновике: занятие уже ${session.status === "running" ? "запущено" : "завершено"}.`}
      </p>
      {rows.length === 0 ? (
        <p>Заданий не выдавали.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>АРМ</th>
              <th>Обучаемый</th>
              <th>№</th>
              <th>Происшествие</th>
              <th>Когда</th>
              <th>Доставка</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => (
              <tr key={item.id}>
                <td className={styles.seat}>{seat(item.participant_id)}</td>
                <td>{fullName(item.participant_id)}</td>
                <td>{item.order}</td>
                <td>{scenarioTitle(item.scenario_id)}</td>
                <td>
                  {item.source === "single" && item.planned_at
                    ? clock(item.planned_at)
                    : item.due_at
                      ? clock(item.due_at)
                      : `через ${item.delay_from_start_s ?? 0} с после старта`}
                </td>
                <td>
                  {item.source === "single" ? (
                    (ASSIGNMENT_STATUS[item.status] ?? item.status)
                  ) : item.delivery_mode === "intentional_mismatch" ? (
                    <span className={styles.exercise}>
                      упражнение: чужая служба
                    </span>
                  ) : (
                    "своей службы"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
