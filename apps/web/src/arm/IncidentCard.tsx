// Карточка происшествия «формата 112» на стороне ДДС — зона 1 макета B: только то,
// что есть на скриншотах arm_dds/06–20, их цвета и раскладка (prototype-b/README.md,
// «Что изменилось в АРМ»). Учебного в карточке нет: время до «Принята» и разбор —
// в учебном слое. Для неподтверждённых операций — явно подписанная справка тренажёра.
// Всё, что пришло от оператора 112, — read-only (Q&A Q12, contracts/ui_spec_arm.md);
// диспетчер ставит статусы строкой «Статус · Номер наряда · Комментарий · ✓ · ✕».
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Card } from "../shared/api";
import { useParticipant } from "./useParticipant";
import { useSession } from "../shared/session";
import {
  availableStatuses,
  canRedirect,
  clockParts,
  commentHint,
  commentOnStatusChange,
  confirmAgainText,
  fullAddress,
  fullDateTime,
  isClosed,
  latePrimaryId,
  okrugName,
  REASON_REQUIRED,
  STATE_LABELS,
  type DispatcherStatus,
  type Service,
} from "./cardModel";
import { ArmIcon } from "./ArmIcon";
import { useCardActions } from "./useCardActions";
import { Softphone } from "./softphone";
import { PhoneDial } from "./phone/PhoneWindow";
import { trainingQuery } from "./softphone/brigade/data";
import { pointerTip } from "./practice/pointer";
import { tutorProgress } from "./practice/tutor";
import { useSpellingHints } from "./useSpellingHints";
import { applySuggestion } from "./spellingModel";
import { isLearning, needsCheck, sessionMode } from "./trainer/stages";
import { commentClarity } from "./trainer/clarity";
import { heardStatus } from "./trainer/heard";
import { trainerStore } from "./trainer/trainerStore";
import { otherServiceStatus } from "./otherServices";
import { useNow } from "./useNow";
import { useCardTools } from "./tools/CardTools";
import { serviceShort } from "../shared/services";
import { CardHistory } from "./CardHistory";
import styles from "./IncidentCard.module.css";

/** Пауза в наборе комментария, после которой тренажёр оценивает его понятность. */
const CLARITY_PAUSE_MS = 1000;

/** Только смены статуса определяют время статуса на плитке своей службы. */
const STATUS_EVENTS: ReadonlySet<string> = new Set([
  "status_change",
  "redirect",
]);

interface StatusDraft {
  /** Строка статуса открыта (карандаш или Alt+Z). */
  open: boolean;
  form: "status" | "redirect";
  status: DispatcherStatus | "";
  serviceNumber: string;
  comment: string;
  redirectTo: string;
}

const draftKey = (cardId: string) => `arm:draft:${cardId}`;

function readDraft(cardId: string): Partial<StatusDraft> | null {
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

function dateTime(value: string): string {
  const moment = new Date(value);
  return `${moment.toLocaleDateString("ru-RU")} в ${moment.toLocaleTimeString("ru-RU")}`;
}

/** Время на плитке службы — часы и минуты, «11:14 Добавлена» (arm_dds/06). */
function tileTime(value: string): string {
  return clockParts(new Date(value)).hm;
}

/**
 * Плитка чужой службы: статус по расписанию мира (TC-07, «Живая смена»), «11:14 Принята».
 * Своя секунда — только у плитки: карточка целиком каждую секунду не перерисовывается.
 */
function ForeignTile({
  cardId,
  serviceId,
  name,
  appearedAt,
}: {
  readonly cardId: string;
  readonly serviceId: string;
  readonly name: string;
  readonly appearedAt: string;
}) {
  const now = useNow();
  const step = otherServiceStatus(cardId, serviceId, appearedAt, now);
  return (
    <div
      className={styles.tile}
      data-service-state={step.state}
      data-help="tile-foreign"
    >
      <span className={styles.tileUp} aria-hidden="true">
        <ArmIcon name="up" size="tiny" />
      </span>
      <span className={styles.tileName}>{name}</span>
      <span className={styles.tileState}>
        {tileTime(new Date(step.atMs).toISOString())} {STATE_LABELS[step.state]}
      </span>
    </div>
  );
}

/** Порядок полей строки статуса: Tab и Shift+Tab ходят по ним по кругу (README B). */
const LINE_FIELDS = "select, input, button";

export function IncidentCard({
  card,
  services,
  onClose,
  onReview,
  softphone = true,
  softphoneInPhone = true,
}: {
  card: Card;
  services: Service[];
  onClose: () => void;
  /** Разбор закрытой карточки — для проводника тренировки (T-031). */
  onReview?: () => void;
  /**
   * Свой софтфон карточки. Нет — разговор финальной смены ведёт окно телефона без
   * открытой карточки (HQ-033, `phone/CardLine.tsx`): линия на АРМ одна.
   */
  softphone?: boolean;
  /**
   * Связь карточки — в окне телефона. Нет — там идёт разговор другой карточки (HQ-033):
   * софтфон остаётся смонтированным и выводит контакты и табло сил этой карточки, как
   * только разговор кончится или встанет на удержание.
   */
  softphoneInPhone?: boolean;
}) {
  // Служба и рабочее место — из участия в занятии этой карточки.
  const context = useParticipant(card.session_id, card.trainee_id);
  const ownServiceId = context.participant?.dds_service_id ?? null;
  const workstation = context.participant?.workstation_number ?? "";
  // Ф.И.О. во всплывающем окне при наведении на номер пользователя (памятка ДДС, с. 25).
  const { user } = useSession();
  const operatorName = user.id === card.trainee_id ? user.full_name : undefined;
  const closed = isClosed(card);
  const canAct = context.canAct && !closed;
  const tools = useCardTools();
  const actions = useCardActions(card.id, canAct);
  const statuses = canAct ? availableStatuses(card.state, ownServiceId) : [];
  // Черновик строки статуса переживает переход к другому происшествию и обратно:
  // при параллельной работе диспетчер уходит на новую карточку посреди записи.
  const draft = useRef(readDraft(card.id)).current;
  // Строка статуса всегда на виду, пока карточку можно вести (решение пользователя
  // 12.10, docs/decisions.md): искать карандаш на каждом статусе неудобно. Карандаш
  // и Alt+Z ставят в неё фокус; закрывается только форма перенаправления.
  const lineOpen = true;
  const [form, setForm] = useState<"status" | "redirect">(
    draft?.form ?? "status",
  );
  const [status, setStatus] = useState<DispatcherStatus | "">(
    draft?.status ?? "",
  );
  // Номер наряда остаётся от прошлого статуса, как на скриншотах 12–19.
  const [serviceNumber, setServiceNumber] = useState(
    draft?.serviceNumber ?? card.current.service_number,
  );
  const [comment, setComment] = useState(draft?.comment ?? "");
  const [redirectTo, setRedirectTo] = useState(draft?.redirectTo ?? "");
  // Черновики комментария по статусам этой карточки: смена статуса в списке не
  // теряет написанное и не подставляет старый текст под новый статус.
  const commentDrafts = useRef<Partial<Record<DispatcherStatus, string>>>(
    draft?.status ? { [draft.status]: draft.comment ?? "" } : {},
  );
  const submitting = useRef(false);
  useEffect(() => {
    if (closed) clearDraft(card.id);
    else
      writeDraft(card.id, {
        open: true,
        form,
        status,
        serviceNumber,
        comment,
        redirectTo,
      });
  }, [card.id, closed, form, status, serviceNumber, comment, redirectTo]);
  const [error, setError] = useState("");
  const [confirmTerminal, setConfirmTerminal] = useState(false);
  // Журнал раскрывается внутри карточки, не перекрывая её плавающим окном.
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyToggle = useRef<HTMLButtonElement>(null);
  function closeHistory() {
    setHistoryOpen(false);
    historyToggle.current?.focus({ preventScroll: true });
  }
  // Зажатый Alt показывает подсказки сочетаний (инструкция 112, раздел 13; README B).
  const [altHeld, setAltHeld] = useState(false);
  // Подсказки орфографии — только в занятии, где преподаватель их включил.
  const spelling = useSpellingHints(card.session_id, card.id, comment, canAct);
  const actionForm = useRef<HTMLDivElement>(null);
  const pencil = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  // Куда вернуть фокус: в строку статуса после открытия или к карандашу после
  // закрытия, чтобы следующий статус ставился с клавиатуры сразу.
  const [focusRequest, setFocusRequest] = useState<{
    to: "line" | "pencil";
    n: number;
  } | null>(null);
  // Элемент, с которого ушла асинхронная отправка (✓ или поле с Enter). Пока
  // ждали сервер, обучаемый мог уйти в окно звонка — тогда фокус не выдёргиваем.
  const focusOrigin = useRef<Element | null>(null);
  // Открытое окно истории встаёт на место строки; черновик строки при этом цел.
  const formShown =
    canAct &&
    lineOpen &&
    !historyOpen &&
    (form === "redirect" || statuses.length > 0);
  useLayoutEffect(() => {
    if (!focusRequest) return;
    const origin = focusOrigin.current;
    focusOrigin.current = null;
    const active = document.activeElement;
    if (origin && active && active !== document.body && active !== origin)
      return;
    const select =
      focusRequest.to === "line"
        ? actionForm.current?.querySelector("select")
        : null;
    // Завершающий статус закрыл карточку и убрал карандаш — фокус на ✕.
    (select ?? pencil.current ?? closeButton.current)?.focus();
  }, [focusRequest]);
  // Строка пропала вместе с правом действовать (завершающий статус,
  // перенаправление, конец занятия) — фокус не теряется на body.
  useLayoutEffect(() => {
    if (!formShown && document.activeElement === document.body)
      (pencil.current ?? closeButton.current)?.focus();
  }, [formShown]);
  // Завершающий статус подтверждают вторым ✓ (или «Сохранить «…»» подсказки «Вместе»): строка закрывается
  // раньше, чем сервер закроет карточку, и фокус встаёт на карандаш. Карандаш пропадает
  // вместе с закрытием — фокус переходит на ✕, а не теряется на body.
  const wasClosed = useRef(closed);
  useLayoutEffect(() => {
    if (
      closed &&
      !wasClosed.current &&
      document.activeElement === document.body
    )
      closeButton.current?.focus();
    wasClosed.current = closed;
  }, [closed]);
  const opened = useRef(false);

  const cardBox = useRef<HTMLElement>(null);
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
  // Панель истории открывается стрелкой своей службы; черновик статуса сохраняется.
  const historyShown = historyOpen;
  const training = useQuery({
    ...trainingQuery(card.id),
    enabled: canAct,
    retry: false,
  });

  // Время последнего перехода своей службы — из журнала, а не время появления.
  const lastStatusEvent = history.data
    ?.filter((event) => STATUS_EVENTS.has(event.type))
    .at(-1);
  const ownStatusAt = lastStatusEvent?.server_ts ?? card.appeared_at;
  // «Принята» / «Не принята» позже 30 с — время записи красным (памятка, с. 21, 25).
  const lateId = history.data ? latePrimaryId(card, history.data) : null;
  const tutorInput = {
    state: card.state,
    events: history.data ?? [],
  };
  // Обучение и тесты (решение 17.10): подсказки тренажёра живут только в обучающем
  // упражнении, этапы «Смотрю» и «Вместе» (и показ опытного). «Сам», ступени 2–4,
  // каталог сценариев и занятия преподавателя — чистый АРМ: ни подсказки, ни строки
  // «Услышано по телефону», ни понятности комментария.
  const mode = context.practice ? sessionMode(card.session_id) : null;
  const learning = isLearning(mode);
  // Проводник-указатель (DT-07): шаг и фраза к нему. «Вместе» показывает её подсказкой
  // у элемента шага, «Смотрю» по ней ведёт курсор (trainer/TrainerCoach.tsx).
  const tip =
    learning && canAct
      ? pointerTip({
          progress: tutorProgress(tutorInput),
          state: card.state,
          missingReports: training.data?.missing_report_states ?? [],
          incoming: Boolean(training.data?.incoming?.length),
        })
      : null;

  const progress = tutorProgress(tutorInput);
  const checked =
    form === "status" && status && needsCheck(status) ? status : null;
  // Проверка взведена: подпись у ✓ говорит, что сделает второе нажатие.
  const confirmAgain =
    confirmTerminal && checked ? confirmAgainText(checked) : null;
  // «Услышано по телефону» (TC-05): статус, названный старшим, — подсказкой у строки статуса
  // во «Вместе». В показе карточку ведёт тренажёр, в тестах подсказок нет.
  const heard =
    canAct && mode === "together" && form === "status"
      ? heardStatus(training.data?.messages ?? [], statuses, status)
      : null;
  // Понятность комментария (TC-08): подсказка появляется, когда обучаемый на секунду
  // замолчал, а не на каждой букве («около…» не должно мигать как «ок»).
  const [settled, setSettled] = useState(comment);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setSettled(comment),
      CLARITY_PAUSE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [comment]);
  const clarity =
    canAct && mode === "together" && !closed && settled === comment
      ? commentClarity(comment, form === "status" ? status : "", ownServiceId)
      : null;
  const voice = {
    cardId: card.id,
    sessionId: card.session_id,
    number: card.source.number,
    practice: context.practice,
    step: progress.current,
    rejected: progress.rejected,
    tip,
    // Строка статуса закрыта — шаг статуса начинается с карандаша своей плитки.
    lineOpen: formShown,
    closed,
    canAct,
    check:
      confirmTerminal && checked
        ? {
            status: checked,
            label: STATE_LABELS[checked],
            comment: comment.trim(),
            required: REASON_REQUIRED.has(checked),
          }
        : null,
    // Помощь — «Покажи» (и подсказки застрявшему прежних тренировок) из журнала карточки.
    helps: (history.data ?? []).filter(
      (event) =>
        event.type === "hint_open" &&
        /^(tutor|show):/.test(String(event.payload.hint_id)),
    ).length,
    summary: [
      card.source.incident_class,
      fullAddress(card.source.address),
      card.source.victims ? "Есть пострадавшие." : "Пострадавших нет.",
    ]
      .filter(Boolean)
      .join(". ")
      .replace(/\.\./g, "."),
    heard: heard ? { status: heard, label: STATE_LABELS[heard] } : null,
    clarity,
  };
  const voiceHandlers = {
    confirmCheck: () => void submit(),
    backToComment,
    helped: (hintId: string) => void actions.hintOpen(hintId),
    review: onReview,
    cardElement: () => cardBox.current,
    applyHeard,
    applyClarity,
  };
  // Голос — после каждой отрисовки: хранилище само решает, изменилось ли что-то.
  useEffect(() => trainerStore.setCard(voice, voiceHandlers));
  useEffect(() => () => trainerStore.clearCard(card.id), [card.id]);

  /**
   * «Подставить» в подсказке «Вместе»: статус, названный старшим, выбирается в строке статуса,
   * фокус — в комментарий. Сохраняет обучаемый сам («Подтвердить»), строка статусов до этого
   * не меняется.
   */
  function applyHeard(next: DispatcherStatus) {
    if (!canAct || !statuses.includes(next)) return;
    changeStatus(next);
    setHistoryOpen(false);
    window.requestAnimationFrame(() =>
      actionForm.current
        ?.querySelector<HTMLInputElement>('input[aria-label="Комментарий"]')
        ?.focus(),
    );
  }

  /** «Подставить» в подсказке «Вместе»: исправленный комментарий вместо набранного. */
  function applyClarity(next: string) {
    if (!canAct) return;
    setComment(next);
    setConfirmTerminal(false);
    setError("");
    window.requestAnimationFrame(() =>
      actionForm.current
        ?.querySelector<HTMLInputElement>('input[aria-label="Комментарий"]')
        ?.focus(),
    );
  }

  /** Проверка открыта — «Вернуться к комментарию» (и Esc): фокус в комментарий. */
  function backToComment() {
    setConfirmTerminal(false);
    actionForm.current
      ?.querySelector<HTMLInputElement>('input[aria-label="Комментарий"]')
      ?.focus();
  }

  /** Очистить ввод строки; номер наряда остаётся. */
  function clearInput() {
    if (status) delete commentDrafts.current[status];
    setStatus("");
    setComment("");
    setRedirectTo("");
    setError("");
    setConfirmTerminal(false);
  }

  /**
   * Закрыть строку статуса. `origin` — фокус на момент асинхронной отправки:
   * вернуть его к карандашу можно, только если обучаемый никуда не перешёл.
   */
  function closeLine(origin: Element | null = null) {
    focusOrigin.current = origin;
    clearInput();
    setForm("status");
    setFocusRequest((value) => ({ to: "pencil", n: (value?.n ?? 0) + 1 }));
  }

  function openLine(next: "status" | "redirect") {
    if (next !== form) {
      if (status) commentDrafts.current[status] = comment;
      setForm(next);
      setStatus("");
      setRedirectTo("");
      setError("");
      setConfirmTerminal(false);
    }
    setHistoryOpen(false);
    setFocusRequest((value) => ({ to: "line", n: (value?.n ?? 0) + 1 }));
  }

  /** Карандаш и Alt+Z: фокус в строку статуса (из перенаправления — назад к статусу). */
  function togglePencil() {
    if (closed || statuses.length === 0) return;
    openLine("status");
  }

  async function submitStatus(origin: Element | null) {
    if (!canAct) return;
    const demoAction = trainerStore.demoActionGuard(card.id);
    const stillCurrent = () => {
      if (!demoAction || demoAction()) return true;
      // Снятая пауза не оживляет старое ✓: следующая попытка проверяет всё заново.
      // Иначе autopilot продолжал бы ждать снятия уже отменённой проверки.
      setConfirmTerminal(false);
      return false;
    };
    if (!stillCurrent()) return;
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
    // поступить после открытия строки или событие обновления могло потеряться.
    // Сервер без доклада статус не примет (409 report_required, C-01).
    const evidence = await training.refetch();
    if (!stillCurrent()) return;
    if (!evidence.data) {
      setError(
        "Не удалось проверить доклады бригады. Повторите после восстановления связи.",
      );
      return;
    }
    if (
      evidence.data.missing_report_states?.some((state) => state === status)
    ) {
      // Это локальная проверка, не попытка смены статуса. Доклад мог уже прийти:
      // посланный ради журнала status_change в этом случае действительно изменил бы карточку.
      setError("Сначала получите и прослушайте доклад бригады об этом этапе.");
      return;
    }
    // Перед «Не принята», «Отказ», «Работы завершены» первое ✓ только взводит проверку:
    // у ✓ — подпись «Нажмите ✓ ещё раз…» (во всех режимах), во «Вместе» и «Смотрю» — ещё
    // памятка ДДС подсказкой у строки. Второе ✓, Enter или «Сохранить «…»» сохраняют.
    if (needsCheck(status) && !confirmTerminal) {
      setConfirmTerminal(true);
      return;
    }
    await sendNumber();
    if (!stillCurrent()) return;
    if (!(await actions.statusChange(status, comment.trim()))) {
      setError(
        "Действие не принято сервером. Проверьте очередь действий над карточкой, очистите её и повторите статус.",
      );
      return;
    }
    // Строка очищается до обновления истории, как в АРМ после ✓. Статус уже
    // подтверждён: чтение истории не держит submitting и не отбрасывает Enter для
    // следующего статуса (гонка из #93). Ошибку чтения хранит query.
    closeLine(origin);
    void history.refetch();
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

  // Строка статуса с клавиатуры (README B): Enter — ✓, Tab и Shift+Tab — по полям
  // строки по кругу, цифра в «Статус» — пункт списка. Esc — в обработчике окна ниже.
  function onLineKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    const target = event.target;
    if (event.key === "Enter" && !event.shiftKey) {
      if (target instanceof HTMLButtonElement) return;
      event.preventDefault();
      if (!event.repeat) void submit();
      return;
    }
    if (event.key === "Tab") {
      const fields = [
        ...event.currentTarget.querySelectorAll<HTMLElement>(LINE_FIELDS),
      ];
      const index = fields.indexOf(target as HTMLElement);
      if (index < 0) return;
      event.preventDefault();
      const step = event.shiftKey ? -1 : 1;
      fields[(index + step + fields.length) % fields.length].focus();
      return;
    }
    if (
      form === "status" &&
      target instanceof HTMLSelectElement &&
      /^[1-9]$/.test(event.key) &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      const option = target.options[Number(event.key)];
      if (option) changeStatus(option.value as DispatcherStatus);
    }
  }

  // Esc, Alt+Z, Alt+O и подсказки сочетаний при зажатом Alt. Обработчик окна карточки
  // ставится раньше обработчика ArmPage и первым гасит Esc, пока открыта строка или
  // история: тогда Esc закрывает их, а не карточку.
  const keys = useRef<{ escape: () => boolean; pencil: () => void }>({
    escape: () => false,
    pencil: togglePencil,
  });
  keys.current = {
    pencil: togglePencil,
    escape: () => {
      // Открытую подсказку Esc закрывает первой — её обработчик на document.
      if (
        cardBox.current?.querySelector(
          'button[aria-label^="Подсказка"][aria-expanded="true"]',
        )
      )
        return false;
      if (historyOpen) {
        closeHistory();
        return true;
      }
      if (confirmTerminal) {
        // Esc при взведённой проверке — назад к комментарию, проверка снята.
        backToComment();
        return true;
      }
      if (form === "redirect") {
        closeLine();
        return true;
      }

      // Строка всегда на виду: Esc в ней уводит фокус к карандашу, черновик цел.
      // Карточку Esc закрывает уже вторым нажатием — написанное не теряется.
      if (actionForm.current?.contains(document.activeElement)) {
        pencil.current?.focus();
        return true;
      }
      return false;
    },
  };
  useEffect(() => {
    // Esc — на document: он срабатывает раньше обработчика окна в ArmPage,
    // который закрывает карточку.
    const down = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Alt") {
        setAltHeld(true);
        return;
      }
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        if (keys.current.escape()) event.preventDefault();
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.code === "KeyZ") {
        event.preventDefault();
        setAltHeld(false);
        keys.current.pencil();
      } else if (event.code === "KeyO") {
        event.preventDefault();
        setAltHeld(false);
        feed.current?.focus({ preventScroll: true });
        feed.current?.scrollIntoView({ block: "nearest" });
      }
    };
    const up = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Alt") setAltHeld(false);
    };
    const blur = () => setAltHeld(false);
    document.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  const kbd = (text: string) =>
    altHeld ? (
      <span className={styles.kbd} aria-hidden="true">
        {text}
      </span>
    ) : null;

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
    closeLine(origin);
    void history.refetch();
  }

  const ownService = services.find((service) => service.id === ownServiceId);
  const ownName = ownService?.name ?? ownServiceId ?? "";
  const okrug = okrugName(card.source.address);

  return (
    <section
      ref={cardBox}
      className={styles.card}
      aria-label={`Происшествие ${card.source.number}`}
    >
      <header className={styles.head} data-help="card-header">
        {/* Трубка, «Отключение», «записи звонков», «список SMS» — arm_dds/06.
            Телефон АРМ в тренажёре не работает: связь службы — в колонке справа. */}
        <div className={styles.call} aria-hidden="true">
          <span className={styles.hang}>
            <ArmIcon name="hang" size="large" />
          </span>
          <div className={styles.off}>
            <div>Отключение</div>
            <div className={styles.miniRow}>
              <span className={styles.miniOff}>записи звонков</span>
              <span className={styles.mini}>список SMS</span>
            </div>
          </div>
        </div>
        {(
          [
            ["АОН", card.source.phone_aon],
            ["предоставленный", card.source.phone_provided],
            ["телефон на место", card.source.phone_scene],
          ] as const
        ).map(([label, value]) => (
          <Fragment key={label}>
            <div className={styles.phoneIcons} aria-hidden="true">
              <ArmIcon name="phone" />
              <ArmIcon name="sms" />
            </div>
            <div className={styles.phone}>
              <span className={styles.label}>{label}</span>
              <span>{value}</span>
            </div>
          </Fragment>
        ))}
        <div className={styles.headInfo}>
          <strong>Происшествие {card.source.number}</strong>
          <span>Сохр. {dateTime(card.appeared_at)}</span>
          <span>Опер. —, АРМ —</span>
        </div>
        <div className={styles.mode}>
          <span className={styles.view} title="Просмотр карточки">
            просмотр
          </span>
          <button
            type="button"
            className={styles.add}
            title="Дополнение карточки"
            onClick={() => tools.show("addition", card)}
          >
            дополнение
          </button>
        </div>
      </header>

      <div className={styles.body}>
        <div className={styles.column}>
          <div
            className={`${styles.box} ${styles.caller}`}
            data-help="card-caller"
          >
            {/* ФИО и статус заявителя одной строкой — памятка ДДС, с. 18, 23
                («Иванов  очевидец»); без ФИО — подпись поля, как на arm_dds/06. */}
            {card.source.caller_name ? (
              <span>
                <strong>{card.source.caller_name}</strong>
                {card.source.caller_status && (
                  <span className={styles.callerStatus}>
                    {card.source.caller_status}
                  </span>
                )}
              </span>
            ) : (
              <span className={styles.callerLabel}>ФИО заявителя</span>
            )}
          </div>
          {/* Адрес у ДДС только для чтения (arm_dds 06–20, DT-14): уточнённый адрес
              диспетчер пишет в комментарий к статусу (памятка ДДС, с. 26). */}
          <div
            className={`${styles.box} ${styles.address}`}
            data-help="card-address"
          >
            <div>
              <strong>Россия, {fullAddress(card.source.address)}</strong>
              {okrug && (
                <>
                  <br />
                  {okrug}
                </>
              )}
            </div>
            <ArmIcon name="pinOff" className={styles.pin} />
          </div>
          <div
            ref={feed}
            className={`${styles.box} ${styles.feed}`}
            data-help="card-description"
            tabIndex={-1}
          >
            {kbd("Alt+O")}
            <div className={styles.feedMeta}>
              {fullDateTime(new Date(card.appeared_at))}
              {"   "}0 УМЦ О.п.
            </div>
            <p>{card.source.description}</p>
          </div>
        </div>

        <div className={styles.column}>
          <div className={styles.flagsRow}>
            <div
              className={`${styles.box} ${styles.flags}`}
              data-help="card-flags"
            >
              <span>Пострадавшие: {card.source.victims ? "да" : "нет"}</span>
              <span>
                Отказ от скорой: {card.source.ambulance_refused ? "да" : "нет"}
              </span>
              <span>
                Заблокированные: {card.source.blocked_people ? "да" : "нет"}
              </span>
            </div>
            <div
              className={`${styles.box} ${styles.badges}`}
              data-help="card-badges"
            >
              {/* Метка ЧС — из исходной карточки; открытые формы не реконструируем по догадке. */}
              <button
                type="button"
                title="ЧС — справка тренажёра"
                onClick={() => tools.show("emergency", card)}
                className={`${styles.chs} ${card.source.emergency ? styles.chsOn : ""}`}
              >
                ЧС <ArmIcon name="bolt" size="tiny" />
              </button>
              <button
                type="button"
                className={styles.chp}
                title="ЧП — справка тренажёра"
                onClick={() => tools.show("chp", card)}
              >
                ЧП <ArmIcon name="warn" size="tiny" />
              </button>
              <button
                type="button"
                className={styles.badgePen}
                aria-label="Карандаш у признаков — справка тренажёра"
                title="Карандаш у признаков — справка тренажёра"
                onClick={() => tools.show("classification", card)}
              >
                <ArmIcon name="pen" size="tiny" />
              </button>
            </div>
          </div>
          <div className={styles.incident} data-help="card-incident">
            <h3 className={styles.incidentHead}>
              <span>
                Происшествие{" "}
                {serviceShort(
                  services,
                  ownServiceId ?? card.source.service_ids[0],
                )}
              </span>
            </h3>
            <div className={styles.tags}>
              {card.source.tags.length
                ? `${card.source.tags.join(" . ")} .`
                : ""}
            </div>
          </div>
          <div
            className={`${styles.box} ${styles.klass}`}
            data-help="card-class"
          >
            Класс.: <strong>{card.source.incident_class}</strong> ;
          </div>
          <div className={`${styles.box} ${styles.klass}`}>[ВИС] Класс.:</div>
        </div>
      </div>

      {/* Телефон ДДС — окно ArmPage (phone/PhoneWindow): Softphone выводит туда разговор
          порталами, звонок остаётся звонком карточки. */}
      {!closed && softphone && (
        <Softphone
          key={card.id}
          cardId={card.id}
          disabled={!canAct}
          serviceIds={card.source.service_ids}
          ownServiceId={ownServiceId}
          cardState={card.state}
          inPhone={softphoneInPhone}
        />
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
          {card.source.service_ids
            .map((id) => serviceShort(services, id))
            .join(", ")}
          ). Ваша служба на занятии — {serviceShort(services, ownServiceId)}:
          статус по ней не ставится.
        </p>
      )}
      {context.isUnavailable && (
        <p role="alert" className={styles.context}>
          Нет данных занятия: неизвестно, за какую службу вы работаете. Действия
          по карточке недоступны — сообщите преподавателю.
        </p>
      )}

      <div className={styles.servicesWrap} data-help="card-services">
        <CardHistory
          key={card.id}
          card={card}
          events={history.data}
          workstation={workstation}
          traineeName={operatorName}
          services={services}
          serviceName={ownName}
          lateId={lateId}
          open={historyShown}
          loading={history.isFetching}
          error={history.isError}
          onRetry={() => void history.refetch()}
          onClose={closeHistory}
        />

        {closed && !historyShown && onReview && user.id === card.trainee_id && (
          // Карточка закрыта — на месте строки статуса вход в разбор, во всех режимах
          // (проверка 17.10: после «Сам» разбора не было нигде).
          <div className={styles.line}>
            <div className={`${styles.form} ${styles.closedLine}`}>
              <span>Карточка закрыта.</span>
              <button
                type="button"
                className={styles.review}
                onClick={onReview}
              >
                Разбор
              </button>
            </div>
          </div>
        )}
        {formShown && (
          // Строка статуса над полосой служб — arm_dds/08, 09. Экран не затемняется (решение
          // 12.10): карточку можно читать и копировать, пока пишешь комментарий.
          <div className={styles.line}>
            {(error || spelling.length > 0 || confirmAgain) && (
              <div className={styles.lineNotes} data-line-notes="">
                {spelling.length > 0 && (
                  <span
                    className={styles.lineSpelling}
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
                {error && (
                  <span role="alert" className={styles.lineError}>
                    {error}
                  </span>
                )}
                {confirmAgain && (
                  <span
                    role="status"
                    className={styles.lineConfirm}
                    data-confirm-again=""
                  >
                    {confirmAgain}
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
              onKeyDown={onLineKey}
            >
              {form === "status" ? (
                <select
                  value={status}
                  onChange={(event) =>
                    changeStatus(event.target.value as DispatcherStatus | "")
                  }
                  aria-label="Статус"
                  data-help="line-status"
                >
                  <option value="">Статус</option>
                  {statuses.map((value) => (
                    <option key={value} value={value}>
                      {STATE_LABELS[value]}
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
                  data-help="line-service"
                >
                  <option value="">Служба</option>
                  {services
                    .filter((service) => service.id !== ownServiceId)
                    .map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name}
                      </option>
                    ))}
                </select>
              )}
              {/* «Номер наряда» — только в строке статуса (arm_dds/08, 09). Перенаправления в
                  АРМ-112 нет (памятка, docs/dds_memo_check.md № 21) — поле не по документации,
                  убрано (HQ-030, решение 18.10). */}
              {form === "status" && (
                <input
                  value={serviceNumber}
                  onChange={(event) => {
                    setServiceNumber(event.target.value);
                    setConfirmTerminal(false);
                    setError("");
                  }}
                  onBlur={() => void sendNumber()}
                  placeholder="Наряд"
                  aria-label="Номер наряда"
                  data-help="line-number"
                  className={styles.number}
                  maxLength={64}
                  autoComplete="off"
                />
              )}
              <input
                value={comment}
                onChange={(event) => {
                  setComment(event.target.value);
                  setConfirmTerminal(false);
                  setError("");
                }}
                // Что писать при выбранном статусе — пока поле пусто (возвращено 12.10:
                // без подсказки обучаемый не знает, где и что от него ждут).
                placeholder={
                  form === "status" && status
                    ? commentHint(status, ownServiceId)
                    : form === "redirect"
                      ? "Причина перенаправления"
                      : "Комментарий"
                }
                aria-label="Комментарий"
                data-help="line-comment"
                className={styles.comment}
                maxLength={4000}
                autoComplete="off"
              />
              <button
                type="button"
                className={styles.ok}
                onClick={() => void submit()}
                aria-label="Подтвердить"
                data-help="line-confirm"
                title="Подтвердить"
              >
                <ArmIcon name="check" />
              </button>
              <button
                type="button"
                className={styles.cancel}
                onClick={() => closeLine()}
                aria-label="Отменить"
                data-help="line-cancel"
                title="Отменить"
              >
                <ArmIcon name="close" />
              </button>
              {altHeld && (
                <span className={`${styles.kbd} ${styles.kbdLine}`}>
                  Enter ✓ · Esc ✕ · Tab — по полям
                </span>
              )}
            </div>
          </div>
        )}

        <footer className={styles.services}>
          <span className={styles.servicesLabel}>Службы:</span>
          {card.source.service_ids.map((id) => {
            const service = services.find((item) => item.id === id);
            const name = service?.name ?? id;
            if (id !== ownServiceId)
              // Статус чужой службы контракт не передаёт (service_ids без статусов): на
              // плитке — расписание мира (TC-07, otherServices.ts), вид — как arm_dds/06.
              return (
                <ForeignTile
                  key={id}
                  cardId={card.id}
                  serviceId={id}
                  name={name}
                  appearedAt={card.appeared_at}
                />
              );
            return (
              <div
                key={id}
                className={`${styles.tile} ${styles.tileOwn} ${formShown ? styles.tileOpen : ""}`}
                data-help="tile-own"
              >
                <button
                  ref={historyToggle}
                  type="button"
                  className={styles.tileUp}
                  data-help="tile-history"
                  onClick={() => setHistoryOpen((open) => !open)}
                  aria-expanded={historyShown}
                  aria-controls={`card-history-${card.id}`}
                  aria-label="История статусов"
                  title="История статусов"
                >
                  <ArmIcon name={historyShown ? "down" : "up"} size="tiny" />
                </button>
                {!closed && (
                  <button
                    ref={pencil}
                    type="button"
                    className={styles.tilePen}
                    data-help="tile-pencil"
                    disabled={!canAct || statuses.length === 0}
                    onClick={togglePencil}
                    aria-label="Изменить статус"
                    title={
                      !context.canAct
                        ? "Занятие не идёт — статус поставить нельзя"
                        : statuses.length === 0
                          ? "Следующих статусов нет"
                          : "Изменить статус"
                    }
                  >
                    <ArmIcon name="pen" size="tiny" />
                    {kbd("Alt+Z")}
                  </button>
                )}
                <span className={styles.tileName}>{name}</span>
                <span className={styles.tileState}>
                  <span
                    className={
                      lastStatusEvent && lastStatusEvent.id === lateId
                        ? styles.late
                        : undefined
                    }
                  >
                    {tileTime(ownStatusAt)}
                  </span>{" "}
                  {STATE_LABELS[card.state]}
                </span>
              </div>
            );
          })}
          <span className={styles.servicesRight}>
            {/* Значок IP-телефона (GP-09, рекомендации 16.10, п. 8) — единственное
                добавление к полосе служб arm_dds/06. */}
            <PhoneDial />
            {canAct && canRedirect(card.state) && (
              <button
                type="button"
                className={styles.redirect}
                data-help="strip-redirect"
                onClick={() => openLine("redirect")}
              >
                Перенаправить
              </button>
            )}
            <span className={styles.square} aria-hidden="true">
              <ArmIcon name="note" />
            </span>
            <button
              ref={closeButton}
              type="button"
              className={styles.square}
              data-help="strip-close"
              onClick={onClose}
              aria-label="Закрыть карточку"
              title="Закрыть карточку"
            >
              <ArmIcon name="close" />
              {kbd("Esc")}
            </button>
          </span>
        </footer>
      </div>
    </section>
  );
}
