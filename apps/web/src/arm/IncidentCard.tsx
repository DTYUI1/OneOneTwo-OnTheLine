// Карточка происшествия «формата 112» на стороне ДДС.
// Раскладка снята со скриншотов arm_dds/06 (поля), 09 (форма статуса), 12 (история).
// Всё, что пришло от оператора 112, — read-only (Q&A Q12, contracts/ui_spec_arm.md);
// диспетчер правит только service_number и comment и ставит статусы.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Card, type CardEvent } from "../shared/api";
import { useParticipant } from "./useParticipant";
import {
  availableStatuses,
  canRedirect,
  closesCard,
  commentOnStatusChange,
  REASON_REQUIRED,
  STATUS_COMMENT_HINTS,
  formatAddress,
  formatOkrug,
  handlingTimer,
  formatDuration,
  isClosed,
  reactionTimer,
  STATE_LABELS,
  statusFormKey,
  timerLabel,
  visibleHistory,
  type DispatcherStatus,
  type Service,
} from "./cardModel";
import { useCardActions } from "./useCardActions";
import { AddressInput } from "./AddressInput";
import { useCardTiming, useHintsLevel, useWaitingS } from "./useTiming";
import { activeHandling } from "./tabsModel";
import { Softphone } from "./softphone";
import { trainingQuery } from "./softphone/brigade/data";
import { TutorPanel } from "./practice/TutorPanel";
import { tutorProgress } from "./practice/tutor";
import { useSpellingHints } from "./useSpellingHints";
import { applySuggestion } from "./spellingModel";
import styles from "./IncidentCard.module.css";

/** Подписи действий в ленте истории — как их читает преподаватель. */
const ACTION_LABELS: Record<string, string> = {
  deliver: "карточка показана",
  open: "карточка открыта",
  field_change: "правка поля",
  status_change: "изменён статус",
  comment: "комментарий",
  redirect: "перенаправление",
  hint_open: "открыта подсказка",
  call_dial: "набран номер",
  call_dial_target: "вызван адресат",
  call_answer: "абонент ответил",
  call_hangup: "звонок завершён",
  brigades_select: "выбраны бригады",
  message_presented: "учебное сообщение предъявлено",
  message_failed: "учебное сообщение не предъявлено",
} satisfies Record<CardEvent["type"], string>;

/** Какое поле правили — в истории видно без раскрытия значений. */
const FIELD_LABELS: Record<string, string> = {
  service_number: "указан номер наряда",
  comment: "правка комментария",
  address: "введён адрес",
};

interface StatusDraft {
  form: "status" | "redirect" | null;
  status: DispatcherStatus | "";
  serviceNumber: string;
  comment: string;
  redirectTo: string;
}

/** Норматив реакции по умолчанию (I-TIME), пока расчёт занятия не загружен. */
const DEFAULT_REACTION_S = 30;

const draftKey = (cardId: string) => `arm:draft:${cardId}`;

function readDraft(cardId: string): StatusDraft | null {
  try {
    return JSON.parse(sessionStorage.getItem(draftKey(cardId)) ?? "null");
  } catch {
    return null;
  }
}

function writeDraft(cardId: string, value: StatusDraft) {
  try {
    sessionStorage.setItem(draftKey(cardId), JSON.stringify(value));
  } catch {
    // Без хранилища черновик живёт, пока открыта карточка.
  }
}

function clearDraft(cardId: string) {
  try {
    sessionStorage.removeItem(draftKey(cardId));
  } catch {
    // Нечего очищать.
  }
}

function time(value: string): string {
  return new Date(value).toLocaleTimeString("ru-RU");
}

function dateTime(value: string): string {
  const moment = new Date(value);
  return `${moment.toLocaleDateString("ru-RU")} в ${moment.toLocaleTimeString("ru-RU")}`;
}

export function IncidentCard({
  card,
  services,
  handlingNormativeS,
  now,
  onClose,
  onReview,
}: {
  card: Card;
  services: Service[];
  handlingNormativeS: number;
  now: number;
  onClose: () => void;
  /** Открыть разбор закрытой карточки в «Моих результатах» (T-031). */
  onReview?: () => void;
}) {
  // Служба и рабочее место — из участия в занятии этой карточки.
  const context = useParticipant(card.session_id, card.trainee_id);
  const ownServiceId = context.participant?.dds_service_id ?? null;
  const closed = isClosed(card);
  const canAct = context.canAct && !closed;
  const actions = useCardActions(card.id, canAct);
  const statuses = canAct ? availableStatuses(card.state) : [];
  // Черновик формы статуса переживает переход к другому происшествию и обратно:
  // при параллельной работе диспетчер уходит на новую карточку посреди записи.
  const draft = useRef(readDraft(card.id)).current;
  // Форма своей службы открыта всегда, пока можно действовать: статусы идут
  // подряд, и повторный клик перед каждым мешал. Меняется только её режим.
  const [form, setForm] = useState<"status" | "redirect">(
    draft?.form ?? "status",
  );
  const [status, setStatus] = useState<DispatcherStatus | "">(
    draft?.status ?? "",
  );
  const [serviceNumber, setServiceNumber] = useState(
    draft?.serviceNumber ?? card.current.service_number,
  );
  const [comment, setComment] = useState(
    draft?.comment ?? card.current.comment,
  );
  const [redirectTo, setRedirectTo] = useState(draft?.redirectTo ?? "");
  // Черновики комментария по статусам этой карточки: смена статуса в списке не
  // теряет написанное и не подставляет старый текст под новую подсказку.
  const commentDrafts = useRef<Partial<Record<DispatcherStatus, string>>>(
    draft?.status ? { [draft.status]: draft.comment } : {},
  );
  const submitting = useRef(false);
  useEffect(() => {
    if (closed) clearDraft(card.id);
    else
      writeDraft(card.id, { form, status, serviceNumber, comment, redirectTo });
  }, [card.id, closed, form, status, serviceNumber, comment, redirectTo]);
  const [error, setError] = useState("");
  const [confirmTerminal, setConfirmTerminal] = useState(false);
  // Подсказки орфографии — только в занятии, где преподаватель их включил.
  const spelling = useSpellingHints(card.session_id, card.id, comment, canAct);
  const actionForm = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // Просьба вернуть фокус в первый список формы — после отправки, сброса или
  // смены режима, чтобы следующий статус ставился с клавиатуры сразу.
  const [focusRequest, setFocusRequest] = useState(0);
  // Элемент, с которого ушла асинхронная отправка (✓ или поле с Enter). Пока
  // ждали сервер, обучаемый мог уйти в адрес, номер наряда или окно звонка —
  // тогда фокус не выдёргиваем обратно в «Статус».
  const focusOrigin = useRef<Element | null>(null);
  useLayoutEffect(() => {
    if (!focusRequest) return;
    const origin = focusOrigin.current;
    focusOrigin.current = null;
    const active = document.activeElement;
    if (origin && active && active !== document.body && active !== origin)
      return;
    const select = actionForm.current?.querySelector("select");
    // Завершающий статус закрыл карточку и убрал форму — фокус на «Закрыть».
    (select ?? closeButton.current)?.focus();
  }, [focusRequest]);
  // Форма пропала вместе с правом действовать (завершающий статус,
  // перенаправление, конец занятия) — фокус не теряется на body.
  const formShown = canAct && (form === "redirect" || statuses.length > 0);
  useLayoutEffect(() => {
    if (!formShown && document.activeElement === document.body)
      closeButton.current?.focus();
  }, [formShown]);
  // Раскрытых ярусов может быть несколько одновременно (arm_dds/07).
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const opened = useRef(false);
  const historyBox = useRef<HTMLDivElement>(null);
  const [allHistory, setAllHistory] = useState(false);
  // Последнее отправленное значение поля: чтобы правка не ушла дважды
  // (по потере фокуса и повторно при подтверждении статуса).
  const sentNumber = useRef(card.current.service_number);

  // open фиксирует реакцию на карточку: один раз, даже при StrictMode-перемонтировании.
  useEffect(() => {
    if (!canAct || opened.current || card.opened_at) return;
    opened.current = true;
    // Строка списка могла ещё не подтвердить доставку: права на действия у неё и
    // у открытой карточки появляются в одном рендере, и эффект карточки бывает
    // первым. open до deliver сервер отклоняет (409), а отказ останавливает
    // очередь карточки. Повторный deliver безопасен: card_already_delivered.
    void (async () => {
      if (!card.delivered_at) await actions.deliver();
      await actions.open();
    })();
  }, [actions, card.delivered_at, card.opened_at, canAct]);

  const history = useQuery({
    queryKey: ["card-events", card.id],
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/cards/{id}/events", {
        params: { path: { id: card.id } },
        signal,
      });
      if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
      return data;
    },
  });
  // Свежая запись истории всегда на виду — как доклады в телефоне (Softphone).
  useEffect(() => {
    const box = historyBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [history.data, allHistory]);
  const training = useQuery({
    ...trainingQuery(card.id),
    enabled: canAct,
    retry: false,
  });

  // Время последнего перехода своей службы — из истории действий, а не время появления.
  const lastStatusEvent = history.data
    ?.filter((event) => ["status_change", "redirect"].includes(event.type))
    .at(-1);
  const ownStatusAt = lastStatusEvent?.server_ts ?? card.appeared_at;
  // Отработка — по общему расчёту C-02 и версии методики занятия; пока политика
  // не загружена, держим прежний счётчик, чтобы шапка не мигала.
  // Подсказки начального уровня — только если включены в снимке занятия.
  const hintsLevel = useHintsLevel(card.session_id);
  const timing = useCardTiming(card, now);
  // Пока бригада едет или работает, счёт диспетчера стоит: норматив v3 — по
  // активной обработке, без подтверждённого ожидания (I-TIME v3 п.5–6).
  const waitingS = useWaitingS(
    card.id,
    Boolean(timing?.handling.running && timing.version === 3),
  );
  const handling = timing ? activeHandling(timing, waitingS) : null;
  const legacy = handlingTimer(card, handlingNormativeS, now);
  const timer = timing
    ? {
        seconds: Math.floor(handling?.seconds ?? 0),
        overdue: handling?.overdue ?? false,
        title: `Отработка по методике v${timing.version}: от открытия до завершения. ${
          timing.version === 3
            ? "Время ожидания бригады не считается — норматив сравнивается с активной работой диспетчера."
            : ""
        }`,
      }
    : { ...legacy, title: "Время отработки карточки" };
  // До «Принята / Не принята» горит норма реакции — та же, что на вкладке.
  const timerPhase = timerLabel(card.state);
  const reactionNormativeS = timing?.reaction.normative ?? DEFAULT_REACTION_S;
  const reactionLegacy = reactionTimer(card, reactionNormativeS, now);
  const shownTimer =
    timerPhase === "реакция"
      ? {
          seconds: Math.floor(
            timing?.reaction.seconds ?? reactionLegacy.seconds,
          ),
          overdue: timing?.reaction.over ?? reactionLegacy.overdue,
          title: `Реакция: от появления вызова в списке до статуса «Принята» или «Не принята». Норматив ${reactionNormativeS} с.`,
        }
      : timer;
  const tutorInput = {
    state: card.state,
    events: history.data ?? [],
    servicePhone:
      services.find((service) => service.id === ownServiceId)?.phone_ext ??
      null,
  };
  // Шаг «Принять решение» в тренировке с подсказчиком: взгляд — на плитку своей службы.
  const tutorDecide =
    context.practice &&
    hintsLevel >= 1 &&
    canAct &&
    !tutorProgress(tutorInput).done.has("decide");
  const shownHistory = visibleHistory(history.data ?? [], allHistory);

  function toggleService(id: string) {
    setUnfolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /**
   * Сбросить ввод формы; форма остаётся на месте в режиме статуса. `origin` —
   * фокус на момент асинхронной отправки: вернуть его в «Статус» можно, только
   * если обучаемый за время ответа сервера никуда не перешёл.
   */
  function reset(origin: Element | null = null) {
    focusOrigin.current = origin;
    if (status) delete commentDrafts.current[status];
    setForm("status");
    setStatus("");
    setComment("");
    setRedirectTo("");
    setError("");
    setConfirmTerminal(false);
    setFocusRequest((value) => value + 1);
  }

  function openForm(next: "status" | "redirect") {
    if (next !== form) {
      if (status) commentDrafts.current[status] = comment;
      setForm(next);
      setStatus("");
      setRedirectTo("");
      setError("");
      setConfirmTerminal(false);
    }
    setFocusRequest((value) => value + 1);
  }

  async function submitStatus(origin: Element | null) {
    if (!canAct) return;
    if (!status) {
      setError("Выберите статус.");
      return;
    }
    if (!comment.trim()) {
      setError(
        REASON_REQUIRED.has(status)
          ? "Укажите причину: почему карточка не принята или работы не выполнены, и кому передана информация."
          : "Комментарий обязателен: его читает следующее звено.",
      );
      return;
    }
    // Проверяем на сервере прямо перед постановкой в очередь: доклад мог
    // поступить после открытия формы или событие обновления могло потеряться.
    const evidence = await training.refetch();
    if (!evidence.data) {
      setError(
        "Не удалось проверить доклады бригады. Повторите после восстановления связи.",
      );
      return;
    }
    if (
      evidence.data.missing_report_states?.some((state) => state === status)
    ) {
      setError("Сначала получите и прослушайте доклад бригады об этом этапе.");
      return;
    }
    if (closesCard(status) && !confirmTerminal) {
      setConfirmTerminal(true);
      return;
    }
    await sendNumber();
    if (!(await actions.statusChange(status, comment.trim()))) {
      setError(
        "Действие не принято сервером. Проверьте очередь действий над карточкой, очистите её и повторите статус.",
      );
      return;
    }
    // Форма остаётся открытой пустой: следующий статус — сразу. Сброс до
    // обновления истории, чтобы медленный ответ не стёр уже начатый ввод.
    reset(origin);
    await history.refetch();
  }

  async function submit() {
    // Enter и ✓ могут прийти подряд, пока идёт проверка докладов: одна отправка.
    if (submitting.current) return;
    submitting.current = true;
    const origin = document.activeElement;
    try {
      await (form === "status" ? submitStatus(origin) : submitRedirect(origin));
    } finally {
      submitting.current = false;
    }
  }

  function onFormKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    const action = statusFormKey(
      event.key,
      event.shiftKey,
      event.target instanceof HTMLInputElement,
    );
    if (action === "cancel") {
      // Открытую подсказку (любую в карточке, не только у формы) Esc закрывает
      // первой — её обработчик на document.
      if (
        event.currentTarget
          .closest("section")
          ?.querySelector(
            'button[aria-label^="Подсказка"][aria-expanded="true"]',
          )
      )
        return;
      // Esc только сбрасывает ввод формы: ArmPage пропускает событие с
      // defaultPrevented и не уводит в реестр посреди звонка.
      event.preventDefault();
      reset();
    } else if (action === "submit") {
      event.preventDefault();
      if (!event.repeat) void submit();
    }
  }

  function changeStatus(next: DispatcherStatus | "") {
    if (status) commentDrafts.current[status] = comment;
    setStatus(next);
    if (next)
      setComment(
        commentOnStatusChange(
          comment,
          card.current.comment,
          commentDrafts.current[next],
        ),
      );
    setConfirmTerminal(false);
    setError("");
  }

  async function sendNumber() {
    if (!canAct || serviceNumber === sentNumber.current) return;
    // Помечаем до await: клик «Подтвердить» снимает фокус (onBlur) и тут же
    // вызывает отправку статуса — без этого номер уходил дважды.
    const previous = sentNumber.current;
    sentNumber.current = serviceNumber;
    if (!(await actions.fieldChange("service_number", serviceNumber)))
      sentNumber.current = previous;
  }

  async function submitRedirect(origin: Element | null) {
    if (!canAct) return;
    if (!redirectTo) {
      setError("Выберите службу.");
      return;
    }
    if (!comment.trim()) {
      setError("Укажите причину перенаправления.");
      return;
    }
    if (!(await actions.redirect(redirectTo, comment.trim()))) {
      setError(
        "Действие не принято сервером. Проверьте очередь действий над карточкой, очистите её и повторите действие.",
      );
      return;
    }
    reset(origin);
    await history.refetch();
  }

  return (
    <section
      className={styles.card}
      aria-label={`Происшествие ${card.source.number}`}
    >
      <header className={styles.head} data-help="card-header">
        <div className={styles.phones}>
          {(
            [
              ["АОН", card.source.phone_aon],
              ["предоставленный", card.source.phone_provided],
              ["телефон на место", card.source.phone_scene],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className={styles.phone}>
              <span className={styles.phoneLabel}>{label}</span>
              <span className={styles.phoneValue}>{value || "—"}</span>
            </div>
          ))}
        </div>
        <div className={styles.headInfo}>
          <strong>Происшествие {card.source.number}</strong>
          <span>Сохр. {dateTime(card.appeared_at)}</span>
          <span>Статус: {STATE_LABELS[card.state]}</span>
        </div>
        {closed && onReview && (
          <button type="button" className={styles.review} onClick={onReview}>
            Разбор
          </button>
        )}
        <div
          className={shownTimer.overdue ? styles.timerOverdue : styles.timer}
          title={shownTimer.title}
        >
          <span className={styles.fieldLabel}>{timerPhase}</span>
          {formatDuration(shownTimer.seconds)}
        </div>
      </header>

      {/* Подсказчик — в тренировке с подсказками (ступень 1); на ступенях 2–4 сам. */}
      {context.practice && hintsLevel >= 1 && (
        <TutorPanel input={tutorInput} onReview={onReview} />
      )}

      <div className={styles.body}>
        <div className={styles.left}>
          <div className={styles.caller}>
            <span className={styles.fieldLabel}>ФИО заявителя</span>
            <span>{card.source.caller_name || "—"}</span>
          </div>
          <div className={styles.address} data-help="card-address">
            <strong>{formatOkrug(card.source.address)}</strong>
            <div>{formatAddress(card.source.address)}</div>
          </div>
          {/* Порядок arm_dds/06 и порядок действий: прочитал, что случилось, —
              переписал адрес со слов заявителя. */}
          <div className={styles.feed} data-help="card-description">
            <div className={styles.feedLine}>
              <span className={styles.feedMeta}>
                {dateTime(card.appeared_at)} · оператор 112
              </span>
              <p>{card.source.description}</p>
            </div>
          </div>
          <div data-help="card-address-input">
            <AddressInput
              key={card.id}
              saved={card.current.address ?? null}
              disabled={!canAct || closed}
              onSave={actions.addressChange}
            />
          </div>
        </div>

        <div className={styles.right}>
          <div className={styles.flags}>
            <span>Пострадавшие: {card.source.victims ? "да" : "нет"}</span>
            <span>
              Отказ от скорой: {card.source.ambulance_refused ? "да" : "нет"}
            </span>
            <span>
              Заблокированные: {card.source.blocked_people ? "да" : "нет"}
            </span>
            {card.source.emergency && (
              <span className={styles.emergency}>ЧС</span>
            )}
          </div>
          <div className={styles.incident} data-help="card-incident">
            <h3 className={styles.incidentHead}>
              Происшествие {ownServiceId ?? card.source.service_ids[0]}
            </h3>
            <div className={styles.tags}>
              {card.source.tags.length
                ? card.source.tags.join(" . ")
                : "теги не заданы"}
            </div>
            <div
              className={styles.incidentClass}
              title={`Код типа: ${card.source.incident_type_code}`}
            >
              Класс.: <strong>{card.source.incident_class}</strong>
            </div>
          </div>

          <div
            ref={historyBox}
            className={styles.history}
            data-help="card-history"
          >
            <div className={styles.historyHead}>
              <h3>История статусов</h3>
              {Boolean(history.data?.length) && (
                <button
                  type="button"
                  className={styles.pencil}
                  aria-pressed={allHistory}
                  onClick={() => setAllHistory(!allHistory)}
                >
                  {allHistory ? "только статусы" : "все действия"}
                </button>
              )}
            </div>
            {history.isPending && <p>Загрузка…</p>}
            {history.data?.length === 0 && <p>Действий пока нет.</p>}
            {Boolean(history.data?.length) && shownHistory.length === 0 && (
              <p>Статусов пока нет.</p>
            )}
            <ul>
              {/* Служебные записи скрыты атрибутом hidden, а не убраны: журнал
                  целиком остаётся в разметке (e2e ждут по нему открытие карточки),
                  на экране — только ключевые, как на arm_dds/12. */}
              {history.data?.map((event) => (
                <li key={event.id} hidden={!shownHistory.includes(event)}>
                  <span className={styles.feedMeta}>
                    {time(event.server_ts)}
                  </span>{" "}
                  {event.type === "status_change"
                    ? STATE_LABELS[String(event.payload.state) as Card["state"]]
                    : event.type === "field_change"
                      ? (FIELD_LABELS[String(event.payload.field)] ??
                        ACTION_LABELS.field_change)
                      : (ACTION_LABELS[event.type] ?? event.type)}
                  {typeof event.payload.comment === "string" &&
                  event.payload.comment
                    ? ` — ${event.payload.comment}`
                    : ""}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {!closed && (
        <div
          data-help="card-phone"
          onKeyDown={(event) => {
            // Раскрытый телефон обрабатывает Esc сам. Его событие не должно
            // закрывать также страницу карточки (включая активный звонок).
            if (
              event.key === "Escape" &&
              event.currentTarget.querySelector('button[aria-expanded="true"]')
            ) {
              event.stopPropagation();
            }
          }}
        >
          <Softphone
            key={card.id}
            cardId={card.id}
            disabled={!canAct}
            serviceIds={card.source.service_ids}
            ownServiceId={ownServiceId}
            cardState={card.state}
          />
        </div>
      )}

      {context.isPending && (
        <p className={styles.context}>Загружаем данные занятия…</p>
      )}
      {context.sessionStatus === "finished" && (
        <p className={styles.context}>
          Занятие завершено. Карточка доступна только для просмотра.
        </p>
      )}
      {context.sessionStatus === "draft" && (
        <p className={styles.context}>Занятие ещё не началось.</p>
      )}
      {/* Карточка адресована другим службам: обучаемый не сможет поставить статус,
          и он должен понимать почему (проверка маршрутизации — зона оценщика). */}
      {ownServiceId && !card.source.service_ids.includes(ownServiceId) && (
        <p role="alert" className={styles.context}>
          Эта карточка адресована другой службе (
          {card.source.service_ids.join(", ")}). Ваша служба на занятии —{" "}
          {ownServiceId}: статус по ней не ставится.
        </p>
      )}
      {context.isUnavailable && (
        <p role="alert" className={styles.context}>
          Нет данных занятия: неизвестно, за какую службу вы работаете. Действия
          по карточке недоступны — сообщите преподавателю.
        </p>
      )}

      <footer className={styles.services} data-help="card-services">
        <span className={styles.servicesLabel}>Службы:</span>
        {card.source.service_ids.map((id) => {
          const service = services.find((item) => item.id === id);
          const own = id === ownServiceId;
          const expanded = unfolded.has(id);
          return (
            <div key={id} className={styles.serviceColumn}>
              {/* Верхний ярус раскрывается «стрелкой» и остаётся открытым —
                  как на arm_dds/07, где развёрнуты сразу три службы. Место под
                  ярус занято и у свёрнутой службы (ярус невидим): раскрытие не
                  поднимает строку «Телефон» и не сжимает карточку. */}
              <div
                className={`${own ? styles.detailsOwn : styles.details} ${expanded ? "" : styles.detailsFolded}`}
                aria-hidden={!expanded}
              >
                {own ? (
                  <>
                    <strong>
                      АРМ {context.participant?.workstation_number ?? "—"}
                    </strong>
                    <span>
                      {time(ownStatusAt)} {STATE_LABELS[card.state]}
                    </span>
                    <button
                      className={styles.pencil}
                      disabled={closed || statuses.length === 0}
                      onClick={() => openForm("status")}
                      title="Изменить статус"
                      aria-label="Изменить статус"
                    >
                      ✎
                    </button>
                  </>
                ) : (
                  <span>подразделения не передаются</span>
                )}
              </div>
              <div className={styles.plate}>
                <button
                  className={styles.toggle}
                  onClick={() => toggleService(id)}
                  aria-expanded={expanded}
                  aria-label={
                    expanded
                      ? `Свернуть ${service?.name ?? id}`
                      : `Развернуть ${service?.name ?? id}`
                  }
                >
                  {expanded ? "⌄" : "⌃"}
                </button>
                <button
                  className={
                    own
                      ? `${styles.serviceOwn} ${tutorDecide ? styles.manualNeeded : ""}`
                      : styles.service
                  }
                  disabled={!own || closed || statuses.length === 0}
                  onClick={() => openForm("status")}
                  title={
                    own
                      ? "Ваша служба — поставьте статус"
                      : "Другая служба: её статус система пока не передаёт"
                  }
                >
                  <strong>{service?.name ?? id}</strong>
                  {/* Время и статус — только для своей ДДС: контракт отдаёт service_ids
                      без статуса каждой службы, а в боевом АРМ он есть
                      («11:29 Начало реаги…»). Расширение контракта — за капитаном. */}
                  <span>
                    {own
                      ? `${time(ownStatusAt)} ${STATE_LABELS[card.state]}`
                      : "привлечена"}
                  </span>
                </button>
              </div>
            </div>
          );
        })}
        {formShown && (
          // Форма статуса стоит в строке служб, справа от плашек, — как панель
          // статуса над плашками в боевом АРМ (arm_dds/09). Видна постоянно:
          // место занято сразу, карточка над ней не сдвигается.
          <div className={styles.formDock}>
            {(error ||
              spelling.length > 0 ||
              (form === "status" && status && closesCard(status))) && (
              <div className={styles.formNotes}>
                {spelling.length > 0 && (
                  <span
                    className={styles.formSpelling}
                    role="status"
                    aria-label="Подсказки орфографии"
                  >
                    Проверьте написание:
                    {spelling.map((issue) => (
                      <span
                        key={`${issue.start}-${issue.word}`}
                        className={styles.spellingItem}
                      >
                        <span className={styles.misspelled}>{issue.word}</span>
                        {issue.suggestions.length > 0
                          ? " → "
                          : " — нет в словаре"}
                        {issue.suggestions.map((suggestion) => (
                          <button
                            key={suggestion}
                            type="button"
                            className={styles.spellingFix}
                            aria-label={`Исправить «${issue.word}» на «${suggestion}»`}
                            onClick={() => {
                              setComment(
                                applySuggestion(comment, issue, suggestion),
                              );
                              setConfirmTerminal(false);
                            }}
                          >
                            {suggestion}
                          </button>
                        ))}
                      </span>
                    ))}
                  </span>
                )}
                {form === "status" && status && closesCard(status) && (
                  <span className={styles.formWarning} role="status">
                    {confirmTerminal
                      ? `Карточка будет закрыта: новые звонки и доклады станут недоступны. Нажмите ✓ ещё раз, если сведения о завершении действительно получены.`
                      : `После сохранения «${STATE_LABELS[status]}» карточка закроется для правок: внесите номер наряда и все сведения сейчас.`}
                  </span>
                )}
                {error && (
                  <span role="alert" className={styles.formError}>
                    {error}
                  </span>
                )}
              </div>
            )}
            <div
              ref={actionForm}
              className={styles.form}
              role="group"
              aria-label="Действие по карточке"
              data-help={form === "redirect" ? "card-redirect" : "card-action"}
              onKeyDown={onFormKey}
            >
              {form === "status" ? (
                <select
                  value={status}
                  onChange={(event) =>
                    changeStatus(event.target.value as DispatcherStatus | "")
                  }
                  aria-label="Статус"
                >
                  <option value="">— статус —</option>
                  {statuses.map((value) => (
                    <option
                      key={value}
                      value={value}
                      disabled={training.data?.missing_report_states?.some(
                        (state) => state === value,
                      )}
                    >
                      {STATE_LABELS[value]}
                      {training.data?.missing_report_states?.some(
                        (state) => state === value,
                      )
                        ? " — ждём доклад"
                        : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  value={redirectTo}
                  onChange={(event) => {
                    setRedirectTo(event.target.value);
                    setError("");
                  }}
                  aria-label="Служба для перенаправления"
                >
                  <option value="">— служба —</option>
                  {services
                    .filter((service) => service.id !== ownServiceId)
                    .map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name}
                      </option>
                    ))}
                </select>
              )}
              <input
                value={serviceNumber}
                onChange={(event) => {
                  setServiceNumber(event.target.value);
                  setConfirmTerminal(false);
                  setError("");
                }}
                onBlur={() => void sendNumber()}
                // Поле на снимке памятки ДДС (стр. 24) подписано «Номер наряда».
                placeholder="номер наряда"
                aria-label="Номер наряда"
                className={styles.number}
                maxLength={64}
              />
              <input
                value={comment}
                onChange={(event) => {
                  setComment(event.target.value);
                  setConfirmTerminal(false);
                  setError("");
                }}
                placeholder={
                  form === "status" && status
                    ? STATUS_COMMENT_HINTS[status]
                    : form === "redirect"
                      ? "причина перенаправления"
                      : "комментарий"
                }
                aria-label="Комментарий"
                className={styles.comment}
                maxLength={4000}
              />
              <button
                onClick={() => void submit()}
                aria-label="Подтвердить"
                title="Подтвердить"
              >
                ✓
              </button>
              <button
                onClick={() => reset()}
                aria-label="Отменить"
                title="Отменить"
              >
                ✕
              </button>
            </div>
          </div>
        )}
        {canAct && canRedirect(card.state) && (
          <button
            className={styles.redirect}
            onClick={() => openForm("redirect")}
          >
            Перенаправить
          </button>
        )}
        <button
          ref={closeButton}
          className={styles.close}
          onClick={onClose}
          aria-label="Закрыть карточку"
        >
          ✕
        </button>
      </footer>
    </section>
  );
}
