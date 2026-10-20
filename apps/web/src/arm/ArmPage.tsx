// Рабочее поле ДДС: список происшествий и отдельная страница карточки (arm_dds/06–07).
// Новые карточки прилетают по WS и не прерывают работу с текущей — параллельные карточки (Q&A Q11).
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import { api, type Card } from "../shared/api";
import type { components } from "../api-client/schema";
import { useSession } from "../shared/session";
import { serviceLabel } from "../shared/services";
import {
  clockDate,
  clockParts,
  fullAddress,
  fullDateTime,
  isClosed,
  newestFirst,
  previewRows,
  shortDate,
  STATE_LABELS,
  type Service,
} from "./cardModel";
import { ArmIcon } from "./ArmIcon";
import { IncidentCard } from "./IncidentCard";
import {
  IdleContacts,
  PhoneContext,
  PhoneWindow,
  usePhoneLines,
  usePhoneState,
} from "./phone/PhoneWindow";
import { useHold } from "./phone/useHold";
import { holdMark, type HoldEffect } from "./phone/hold";
import { reportPayload } from "./softphone/heldTalk";
import { contactsFor, ownNumber } from "./softphone/contacts";
import { CardLine } from "./phone/CardLine";
import { ringing as controlRinging } from "./phone/control";
import {
  interruptsCall,
  lineReleased,
  noteTalk,
  openedInPhone,
  talksInPhone,
  type PhoneLine,
} from "./phone/cardLineState";
import { MemoryCheckWindow } from "./memory/MemoryCheckWindow";
import { useCardActions } from "./useCardActions";
import { useNow } from "./useNow";
import { PendingActions } from "./PendingActions";
import { ResultsPanel } from "./results";
import { useHelpGuide } from "../shared/help/HelpProvider";
import {
  ARM_GUIDE,
  CARD_GUIDE,
  RESULTS_GUIDE,
  REFERENCE_GUIDE,
} from "./help/topics";
import { useHelpEnabled } from "./help/useHelpEnabled";
import { ReferenceAccess } from "./ReferenceAccess";
import { ReferencePanel } from "./ReferencePanel";
import { QuizInWorkflow } from "./quiz/QuizButton";
import { useWorkflowExtra } from "../shared/WorkflowGuide";
import { WarmupButton } from "./warmup/WarmupButton";
import { CatalogButton } from "./catalog/CatalogButton";
import { ProgressButton } from "./progress/ProgressButton";
import {
  PracticeButton,
  PracticeAvailabilityNotice,
} from "./practice/PracticeButton";
import { useParticipant } from "./useParticipant";
import { ScreenShareBar } from "./ScreenShareBar";
import { IncidentTabs } from "./IncidentTabs";
import { ParallelBanner, ParallelNotice } from "./ParallelNotice";
import { SwitchCallDialog } from "./SwitchCallDialog";
import { activeCall, callInterruptedBy, type ActiveCall } from "./callGuard";
import { cancelLine, LINE_WAIT_MS, requestLine, requestPickup } from "./pickup";
import { ControlTalk } from "./phone/ControlTalk";
import { workingCards } from "./tabsModel";
import {
  byDate,
  cardArrived,
  emptyListText,
  listKey,
  listPage,
  PAGE_SIZES,
  showsStages,
  trainingLabel,
  trainingStep,
} from "./listModel";
import { TrainerProvider } from "./trainer/TrainerContext";
import { TrainerDialogs } from "./trainer/TrainerDialogs";
import { stopCallSignal } from "./signals";
import { MentorButton, StageSwitch } from "./trainer/StageSwitch";
import { InterfaceTour } from "./tour/InterfaceTour";
import { requestTour } from "./tour/tour";
import { MASCOT_PORTRAIT, useMascotShown } from "../shared/mascot/Mascot";
import { ConnectionNotice, TrainerCoach } from "./trainer/TrainerCoach";
import { HeadsetButton } from "./trainer/HeadsetCheck";
import { TeacherMessages } from "./trainer/TeacherMessages";
import { CardToolsProvider, RegistryTools } from "./tools/CardTools";
import { pinnedFirst, useToolsStore } from "./tools/toolsStore";
import styles from "./ArmPage.module.css";

/**
 * Норматив «Принята» по умолчанию (I-TIME) для подсказки «Вместе»: строка «Принята» ждёт
 * берёт норматив карточки из её расчёта C-02, это — запасное значение и текст окна.
 */
const REACTION_S = 30;

// Колонки реестра — arm_dds/02, 03 и prototype-b: значки строки без подписи,
// «Связи», «Опер.»; учебной колонки реакции в АРМ нет (время до «Принята» — в
// учебном слое). На узком экране второстепенные колонки скрываются.
const COLUMNS: readonly { title: string; optional?: boolean }[] = [
  { title: "", optional: true },
  { title: "Связи" },
  { title: "" },
  { title: "ЧС" },
  { title: "" },
  { title: "Опер.", optional: true },
  { title: "АРМ", optional: true },
  { title: "Номер" },
  { title: "Дата ↓", optional: true },
  { title: "Время" },
  { title: "Тип происшествия" },
  { title: "Постр.", optional: true },
  { title: "Адрес" },
  { title: "", optional: true },
  { title: "Статус службы" },
  { title: "", optional: true },
];

type ListPosition = {
  search: string;
  /** Страница реестра и «Записей на странице»; в старых сохранениях их нет. */
  page?: number;
  pageSize?: number;
  x: number;
  y: number;
  tableX: number;
  cardId: string;
};
function readPosition(key: string): ListPosition | undefined {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Запись реестра — две строки, как в arm_dds/03: основная и «Описание:». Значки
 * строки открывают действия и пояснения. Доставку (deliver) отправляет вкладка
 * происшествия: она видна и поверх открытой карточки (IncidentTabs, 27.09).
 */
function IncidentRow({
  card,
  services,
  now,
  onOpen,
}: {
  card: Card;
  services: readonly Service[];
  now: number;
  onOpen: () => void;
}) {
  const { user } = useSession();
  const participant = useParticipant(card.session_id, user.id).participant;
  const appeared = new Date(card.appeared_at);
  const time = clockParts(appeared);
  // Предпросмотр «⌄» (памятка ДДС, с. 13–14): службы и последние статусы — без открытия
  // карточки, поэтому «Получена службой» не ставится. Журнал — тот же запрос, что у карточки.
  const [preview, setPreview] = useState(false);
  const events = useQuery({
    queryKey: ["card-events", card.id],
    enabled: preview,
    queryFn: async ({ signal }) => {
      const { data, error } = await api.GET("/cards/{id}/events", {
        params: { path: { id: card.id } },
        signal,
      });
      if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
      return data;
    },
  });
  const lastStatusAt =
    events.data
      ?.filter(
        (event) => event.type === "status_change" || event.type === "redirect",
      )
      .at(-1)?.server_ts ?? null;
  const rows = preview
    ? previewRows(
        card,
        services,
        participant?.dds_service_id ?? null,
        lastStatusAt,
        now,
      )
    : [];
  return (
    <>
      <tr
        data-card-id={card.id}
        data-help="arm-row"
        onClick={onOpen}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          // Реестр без мыши: Enter/пробел открывают карточку, ↑/↓ — соседняя
          // карточка. Строка «Описание:» фокуса не получает и пропускается.
          const row = event.currentTarget;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const rows = [
              ...(row.parentElement?.querySelectorAll<HTMLElement>(
                "[data-card-id]",
              ) ?? []),
            ];
            const next =
              rows[rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1)];
            next?.focus();
          }
        }}
        className={`${styles.row} ${styles.mainRow}`}
      >
        <td className={`${styles.icon} ${styles.optional}`}>
          <button
            type="button"
            className={styles.previewToggle}
            data-help="arm-preview"
            aria-expanded={preview}
            aria-label="Предпросмотр карточки"
            title="Предпросмотр карточки"
            onClick={(event) => {
              event.stopPropagation();
              setPreview(!preview);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <ArmIcon name={preview ? "up" : "down"} />
          </button>
        </td>
        <RegistryTools card={card} />
        <td>{card.source.number}</td>
        <td className={styles.optional}>{shortDate(appeared)}</td>
        <td className={styles.time}>
          <b>{time.hm}</b>
          <sup>{time.s}</sup>
        </td>
        <td className={styles.strong}>{card.source.incident_class}</td>
        <td className={styles.optional}>
          {card.source.victims ? "Да" : "Нет"}
        </td>
        <td className={styles.strong}>{fullAddress(card.source.address)}</td>
        <td className={`${styles.icon} ${styles.shield} ${styles.optional}`}>
          <ArmIcon name="shieldOff" />
        </td>
        <td className={styles.state}>
          {/* Занятие завершили раньше, чем карточку закрыли: работа по ней прервана. */}
          {card.interrupted_at && !isClosed(card)
            ? "Прервана"
            : STATE_LABELS[card.state]}
        </td>
        <td className={`${styles.icon} ${styles.optional}`}>
          <ArmIcon name="clip" />
        </td>
      </tr>
      {/* Вторая строка реестра — описание, как в arm_dds/03: по нему вызовы
        различают взглядом. Щелчок по ней открывает ту же карточку. */}
      <tr className={`${styles.row} ${styles.descriptionRow}`} onClick={onOpen}>
        <td colSpan={COLUMNS.length} className={styles.description}>
          <span className={styles.descriptionLabel}>Описание:</span>
          <span className={styles.descriptionMeta}>
            {fullDateTime(appeared)} УМЦ О. п. -
          </span>{" "}
          {card.source.description}
        </td>
      </tr>
      {rows.map((row) => (
        <tr
          key={row.label}
          className={`${styles.row} ${styles.previewRow}`}
          onClick={onOpen}
        >
          <td colSpan={COLUMNS.length} className={styles.description}>
            <span className={styles.descriptionLabel}>{row.label}</span>
            {row.text}
          </td>
        </tr>
      ))}
    </>
  );
}

type BackgroundCard = components["schemas"]["BackgroundCard"];

/**
 * Фоновая отработанная карточка прошлой смены (TC-07, «Живая смена»): та же запись реестра,
 * но не карточка занятия — без `data-card-id`, не открывается и в оценку не входит. Щелчок и
 * «⌄» раскрывают предпросмотр: службы, их статусы и признаки.
 */
function BackgroundRow({
  item,
  services,
  now,
}: {
  item: BackgroundCard;
  services: readonly Service[];
  now: number;
}) {
  const { user } = useSession();
  const participant = useParticipant(item.session_id, user.id).participant;
  const appeared = new Date(item.appeared_at);
  const time = clockParts(appeared);
  const [preview, setPreview] = useState(false);
  const rows = preview
    ? previewRows(
        { ...item, opened_at: null },
        services,
        participant?.dds_service_id ?? null,
        item.status_at,
        now,
      )
    : [];
  const toggle = () => setPreview(!preview);
  return (
    <>
      <tr
        data-background-id={item.id}
        onClick={toggle}
        title="Карточка прошлой смены: только просмотр"
        className={`${styles.row} ${styles.mainRow}`}
      >
        <td className={`${styles.icon} ${styles.optional}`}>
          <button
            type="button"
            className={styles.previewToggle}
            aria-expanded={preview}
            aria-label="Предпросмотр карточки"
            title="Предпросмотр карточки"
            onClick={(event) => {
              event.stopPropagation();
              toggle();
            }}
          >
            <ArmIcon name={preview ? "up" : "down"} />
          </button>
        </td>
        <RegistryTools card={item} />
        <td>{item.source.number}</td>
        <td className={styles.optional}>{shortDate(appeared)}</td>
        <td className={styles.time}>
          <b>{time.hm}</b>
          <sup>{time.s}</sup>
        </td>
        <td className={styles.strong}>{item.source.incident_class}</td>
        <td className={styles.optional}>
          {item.source.victims ? "Да" : "Нет"}
        </td>
        <td className={styles.strong}>{fullAddress(item.source.address)}</td>
        <td className={`${styles.icon} ${styles.shield} ${styles.optional}`}>
          <ArmIcon name="shieldOff" />
        </td>
        <td className={styles.state}>{STATE_LABELS[item.state]}</td>
        <td className={`${styles.icon} ${styles.optional}`}>
          <ArmIcon name="clip" />
        </td>
      </tr>
      <tr className={`${styles.row} ${styles.descriptionRow}`} onClick={toggle}>
        <td colSpan={COLUMNS.length} className={styles.description}>
          <span className={styles.descriptionLabel}>Описание:</span>
          <span className={styles.descriptionMeta}>
            {fullDateTime(appeared)} УМЦ О. п. -
          </span>{" "}
          {item.source.description}
        </td>
      </tr>
      {rows.map((row) => (
        <tr
          key={row.label}
          className={`${styles.row} ${styles.previewRow}`}
          onClick={toggle}
        >
          <td colSpan={COLUMNS.length} className={styles.description}>
            <span className={styles.descriptionLabel}>{row.label}</span>
            {row.text}
          </td>
        </tr>
      ))}
    </>
  );
}

export function ArmPage() {
  const { user, realtime } = useSession();
  const tools = useToolsStore(user.id);
  const now = useNow();
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  const path = useParams()["*"] ?? "";
  const openedId = path.startsWith("cards/") ? path.slice(6) : null;
  // Экран результатов: null — закрыт, иначе карточка, с которой начать разбор.
  const results = path === "results";
  const reference = path === "reference";
  const [reviewId, setReviewId] = useState<string | null>(null);
  const positionKey = (id: string) => `arm:return:${user.id}:${id}`;
  const restored = (location.state?.list ??
    (openedId ? readPosition(positionKey(openedId)) : undefined)) as
    | ListPosition
    | undefined;
  const [search, setSearch] = useState(restored?.search ?? "");
  const [pageNo, setPageNo] = useState(restored?.page ?? 0);
  const [pageSize, setPageSize] = useState<number>(
    restored?.pageSize ?? PAGE_SIZES[0],
  );
  // Новый запрос — с первой страницы, как и «сбросить».
  const changeSearch = (value: string) => {
    setSearch(value);
    setPageNo(0);
  };
  const listPosition = useRef(
    restored ?? { x: 0, y: 0, tableX: 0, cardId: "", search: "" },
  );
  const table = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLElement>(null);
  const isList = !openedId && !results && !reference;
  const restoreList = useRef(true);
  // АРМ сам восстанавливает позицию реестра после карточки. Когда набор строк
  // меняется, привязка прокрутки браузера может сместить эту позицию; на время
  // работы АРМ отключаем её на корне документа.
  useEffect(() => {
    const root = document.documentElement;
    const previousRoot = root.style.overflowAnchor;
    root.style.overflowAnchor = "none";
    return () => {
      root.style.overflowAnchor = previousRoot;
    };
  }, []);
  // Переход к другому происшествию посреди разговора обрывает звонок: сначала спрашиваем.
  const [switching, setSwitching] = useState<{
    call: ActiveCall;
    go: () => void;
  } | null>(null);
  // Разговор финальной смены в окне телефона (HQ-033): софтфон карточки без её открытия.
  const [phoneLine, setPhoneLine] = useState<PhoneLine | null>(null);
  // Окно телефона занято линией (от ответа до отбоя или удержания): софтфон открытой другой
  // карточки ему уступает — ни контактов, ни набора по ней, пока идёт ответ по линии.
  const [lineShown, setLineShown] = useState(false);
  function guarded(targetCardId: string | null, go: () => void) {
    const call = callInterruptedBy(targetCardId);
    if (call && interruptsCall(call, phoneLine)) setSwitching({ call, go });
    else go();
  }
  function openCard(id: string) {
    guarded(id, () => goToCard(id));
  }
  function goToCard(id: string, resumeVersion?: number) {
    listPosition.current = {
      search,
      page: pageNo,
      pageSize,
      x: window.scrollX,
      y: window.scrollY,
      tableX: table.current?.scrollLeft ?? 0,
      cardId: id,
    };
    try {
      // Резерв для браузеров, которые сбрасывают history.state при reload.
      sessionStorage.setItem(
        positionKey(id),
        JSON.stringify(listPosition.current),
      );
    } catch {
      // При запрете хранилища продолжает работать история текущей страницы.
    }
    navigate(`/arm/cards/${encodeURIComponent(id)}`, {
      state: { fromList: true, list: listPosition.current, resumeVersion },
    });
  }
  const fromList = location.state?.fromList === true;
  const leaveCard = useCallback(() => {
    if (openedId && fromList) navigate(-1);
    else navigate("/arm", { replace: true });
  }, [openedId, fromList, navigate]);
  const closePage = useCallback(() => {
    const call = callInterruptedBy(null);
    if (call && interruptsCall(call, phoneLine))
      setSwitching({ call, go: leaveCard });
    else leaveCard();
  }, [leaveCard, phoneLine]);
  useEffect(() => {
    if (isList) return;
    // После справки фокус возвращается в общую шапку. Esc действует на всей
    // странице, но вложенные подсказки и телефон первыми обрабатывают событие.
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closePage();
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [isList, closePage]);
  useLayoutEffect(() => {
    if (!isList) {
      restoreList.current = true;
      window.scrollTo(0, 0);
      page.current?.focus({ preventScroll: true });
    }
  }, [isList, openedId]);

  const cards = useQuery({
    queryKey: ["cards"],
    queryFn: async () => {
      const { data, error } = await api.GET("/cards");
      if (!data) throw new Error(error?.message ?? "Нет связи с сервером.");
      return data;
    },
  });
  // Занятия задают полосу вкладок и строку-правило над реестром.
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: async () => {
      const { data } = await api.GET("/sessions");
      return data ?? [];
    },
  });
  useLayoutEffect(() => {
    // После reload можно вернуться до ответа API: без строк браузер обрезает
    // прокрутку до нуля. Восстанавливаем один раз, когда список уже отрисован
    // вместе со всем, что стоит над ним (вкладки, правило параллельной работы).
    if (!isList || !cards.data || !sessions.data || !restoreList.current)
      return;
    restoreList.current = false;
    const saved = listPosition.current;
    if (table.current) {
      table.current.scrollLeft = saved.tableX;
      const row = [
        ...table.current.querySelectorAll<HTMLElement>("[data-card-id]"),
      ].find((el) => el.dataset.cardId === saved.cardId);
      row?.focus({ preventScroll: true });
    }
    window.scrollTo(saved.x, saved.y);
  }, [isList, cards.data, sessions.data]);
  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const { data } = await api.GET("/services");
      return data ?? ([] as Service[]);
    },
  });
  // Фоновые карточки прошлой смены (TC-07): по идущим занятиям; в реестре — по дате вместе
  // с карточками занятий, ниже карточек своего занятия (byDate).
  const runningIds = (sessions.data ?? [])
    .filter((session) => session.status === "running")
    .map((session) => session.id);
  const backgroundQueries = useQueries({
    queries: runningIds.map((id) => ({
      queryKey: ["background-cards", id],
      staleTime: Infinity,
      retry: false,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const { data, error } = await api.GET(
          "/sessions/{id}/background-cards",
          {
            params: { path: { id } },
            signal,
          },
        );
        if (!data)
          throw new Error(
            error?.message ?? "Не удалось загрузить карточки прошлой смены.",
          );
        return data;
      },
    })),
  });
  const backgroundAll = backgroundQueries.flatMap((query) => query.data ?? []);
  const backgroundKey = backgroundAll.map((item) => item.id).join(",");
  const background = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...backgroundAll]
      .sort((a, b) => Date.parse(b.appeared_at) - Date.parse(a.appeared_at))
      .filter(
        (item) =>
          !query ||
          [
            item.source.number,
            item.source.incident_class,
            fullAddress(item.source.address),
            item.source.description,
          ]
            .join(" ")
            .toLowerCase()
            .includes(query),
      );
    // backgroundAll — новый массив на каждую отрисовку; набор карточек задаёт ключ.
  }, [backgroundKey, search]);
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = newestFirst(cards.data ?? []);
    if (!query) return list;
    return list.filter((card) =>
      [
        card.source.number,
        card.source.incident_class,
        fullAddress(card.source.address),
        card.source.description,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [cards.data, search]);
  // Реестр по страницам (arm_dds/02, 03): карточки занятий и прошлой смены вместе по
  // «Дата ↓», закреплённые закладкой — сверху; новое происшествие — на первой странице.
  const rows = pinnedFirst(byDate(visible, background), tools.pinned);
  const pager = listPage(rows.length, pageNo, pageSize);
  const pageRows = rows.slice(pager.start, pager.end);
  // Пришло новое происшествие — список сам возвращается на первую страницу, где оно стоит.
  const seenCards = useRef<readonly string[] | null>(null);
  useEffect(() => {
    if (!cards.data) return;
    const ids = cards.data.map((card) => card.id);
    if (cardArrived(seenCards.current, ids)) setPageNo(0);
    seenCards.current = ids;
  }, [cards.data]);

  // Служба обучаемого задаётся занятием, поэтому у карточек разных занятий
  // она может отличаться: общую подпись показываем только для одного занятия.
  const sessionIds = [...new Set((cards.data ?? []).map((c) => c.session_id))];
  const context = useParticipant(
    sessionIds.length === 1 ? sessionIds[0] : null,
    user.id,
  );
  // Связь без открытой карточки — служба идущего занятия: карточки прошлых тренировок в
  // реестре не должны лишать окно телефона номеров бригад (HQ-033: по номеру бригады
  // обучаемый ищет карточку вызова).
  const liveSessionIds = sessionIds.filter((id) =>
    (sessions.data ?? []).some(
      (session) => session.id === id && session.status === "running",
    ),
  );
  const listSessionId =
    liveSessionIds.length === 1
      ? liveSessionIds[0]
      : sessionIds.length === 1
        ? sessionIds[0]
        : null;
  const listContext = useParticipant(listSessionId ?? null, user.id);
  // Служба над часами — идущего занятия; карточки нескольких прошлых занятий без идущего —
  // пользователь, как в АРМ (arm_dds/02), а не «зависит от занятия» (стенд 18.10).
  const labelContext = listSessionId ? listContext : context;
  const ownService = services.data?.find(
    (service) => service.id === labelContext.participant?.dds_service_id,
  );
  const ownServiceLabel =
    sessionIds.length > 1 && !listSessionId
      ? user.full_name
      : labelContext.isPending
        ? "загружаем…"
        : (ownService?.name ??
          labelContext.participant?.dds_service_id ??
          "занятие не начато");
  const opened = cards.data?.find((card) => card.id === openedId) ?? null;
  const helpEnabled = useHelpEnabled(opened?.session_id);
  const openedContext = useParticipant(opened?.session_id ?? null, user.id);
  const helpActions = useCardActions(
    opened?.id ?? "",
    Boolean(opened && !isClosed(opened) && openedContext.canAct),
  );
  // «Проверьте себя» — в окне «Порядок работы», а не в ряду учебных кнопок (19.10).
  useWorkflowExtra(QuizInWorkflow);
  // Список происшествий: в объяснении «?» — «Пройти с наставником», повтор обучения по
  // интерфейсу (arm/tour). Без наставника — объяснение как было.
  const mascot = useMascotShown();
  const armGuide = useMemo(
    () =>
      mascot
        ? {
            ...ARM_GUIDE,
            tour: {
              label: "Пройти с наставником",
              start: requestTour,
              icon: MASCOT_PORTRAIT,
            },
          }
        : ARM_GUIDE,
    [mascot],
  );
  useHelpGuide(
    helpEnabled && (!openedId || opened)
      ? openedId
        ? CARD_GUIDE
        : results
          ? RESULTS_GUIDE
          : reference
            ? REFERENCE_GUIDE
            : armGuide
      : null,
    () => {
      if (opened && helpEnabled) void helpActions.hintOpen("help");
    },
  );
  useEffect(() => {
    document.title = opened
      ? `Происшествие ${opened.source.number}`
      : results
        ? "Мои результаты"
        : reference
          ? "Справка"
          : "ГБУ Система 112";
    return () => {
      document.title = "Учебный тренажёр ДДС";
    };
  }, [opened, results, reference]);
  // Идущее занятие или тренировка: карточка вот-вот придёт, ждать осмысленно.
  const hasRunningSession = (sessions.data ?? []).some(
    (session) => session.status === "running",
  );
  // «Тренировка» запускает текущую ступень пути (первая — упражнение с
  // проводником); ключ общий с «Мой путь».
  const progress = useQuery({
    queryKey: ["progress"],
    queryFn: async () => {
      const { data, error } = await api.GET("/progress");
      if (!data) throw new Error(error?.message ?? "Путь недоступен.");
      return data[0] ?? null;
    },
  });
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isList) return;
    // «/» с любого места реестра — к поиску, как в почте и таблицах.
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      const inInput = Boolean(
        target?.closest("input, textarea, select, [contenteditable='true']"),
      );
      if (listKey(event.key, inInput) === "focusSearch") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isList]);
  // Часы АРМ идут по настоящему времени (arm_dds/02–05).
  const clock = clockParts(new Date(now));

  // Телефон ДДС (GP-09, рекомендации 16.10, п. 8): значок на панели открывает окно; без
  // открытой карточки — список контактов без звонка.
  const linkShown = isList || openedId !== null;
  const linkServiceId = opened
    ? (openedContext.participant?.dds_service_id ?? null)
    : (listContext.participant?.dds_service_id ?? null);
  const linkSettings =
    sessions.data?.find(
      (session) => session.id === (opened?.session_id ?? listSessionId),
    )?.settings_snapshot ?? null;

  // Идущие занятия: их карточки — в окне телефона.
  const runningSessionIds = new Set(
    (sessions.data ?? [])
      .filter((session) => session.status === "running")
      .map((session) => session.id),
  );
  // Финальная смена (HQ-033, `settings.final_shift`): вызовы бригад по её карточкам подписаны
  // только бригадой — карточку обучаемый находит сам по номеру направленной бригады.
  const finalSessions = new Set(
    (sessions.data ?? [])
      .filter((session) => session.settings_snapshot.final_shift === true)
      .map((session) => session.id),
  );
  const brigadeOnly = new Set(
    (cards.data ?? [])
      .filter((card) => finalSessions.has(card.session_id))
      .map((card) => card.id),
  );
  // Проверка памяти посреди идущей финальной смены (HQ-033, стоп-кадр прототипа A).
  const finalShift =
    (sessions.data ?? []).find(
      (session) =>
        session.status === "running" &&
        session.settings_snapshot.final_shift === true,
    ) ?? null;
  const finalCards = (cards.data ?? []).filter(
    (card) => card.session_id === finalShift?.id,
  );
  const lineCard =
    (phoneLine &&
      cards.data?.find(
        (card) => card.id === phoneLine.cardId && !isClosed(card),
      )) ||
    null;
  const { rings, missed, controls } = usePhoneLines(
    workingCards(cards.data ?? [], runningSessionIds),
    linkServiceId,
  );
  // Разговор с отделом контроля (TC-07): какой звонок ответили из окна телефона;
  // `resumed` — снят с удержания (вкладки 17.10).
  const [controlLine, setControlLine] = useState<{
    readonly cardId: string;
    readonly callId: string;
    readonly resumed?: boolean;
    readonly onResume?: () => boolean;
  } | null>(null);
  // Линии на удержании (TC-02, вкладки 17.10): собеседник не дождался — обычный отбой в
  // очередь его карточки (у службы — с докладом до удержания); снять с удержания — открыть
  // карточку линии, её разговор снова на связи.
  const resumeVersion = useRef(0);
  const resumeIntent = useRef<{
    version: number;
    locationKey: string;
    ownPath: string | null;
  } | null>(null);
  useLayoutEffect(() => {
    const intent = resumeIntent.current;
    if (!intent || intent.locationKey === location.key) return;
    // Только переход, инициированный этим resume, сохраняет ожидание получателя.
    if (
      intent.ownPath === location.pathname &&
      location.state?.resumeVersion === intent.version
    ) {
      intent.locationKey = location.key;
      intent.ownPath = null;
      return;
    }
    resumeVersion.current += 1;
    resumeIntent.current = null;
    cancelLine();
  }, [location]);
  useEffect(
    () => () => {
      resumeVersion.current += 1;
      cancelLine();
    },
    [],
  );
  const hold = useHold((effect: HoldEffect) => {
    if (effect.type === "hangup") {
      void realtime.enqueue(effect.cardId, {
        client_event_id: crypto.randomUUID(),
        client_ts: new Date().toISOString(),
        type: "call_hangup",
        payload: {
          call_id: effect.callId,
          ...(effect.report ? reportPayload(effect.report) : {}),
        },
      });
      return;
    }
    const { line } = effect;
    const version = ++resumeVersion.current;
    const intent = {
      version,
      locationKey: locationRef.current.key,
      ownPath: null as string | null,
    };
    resumeIntent.current = intent;
    const requestedAt = Date.now();
    const current = () =>
      version === resumeVersion.current &&
      (locationRef.current.key === intent.locationKey ||
        (intent.ownPath === locationRef.current.pathname &&
          locationRef.current.state?.resumeVersion === version)) &&
      Date.now() - requestedAt < LINE_WAIT_MS;
    // После reload сервер мог уже завершить разговор. Ошибка сети — не разрешение
    // снять его: снимок остаётся на удержании, а повтор доступен той же вкладкой.
    void (async () => {
      let data;
      try {
        ({ data } = await api.GET("/calls/{id}", {
          params: { path: { id: line.callId } },
        }));
      } catch {
        return;
      }
      if (!current()) return;
      if (data?.state === "ended") {
        hold.dispatch({ type: "ended", callId: line.callId });
        return;
      }
      if (data?.state !== "talking") return;
      if (
        openedId !== line.cardId &&
        (line.kind === "control" ||
          !talksInPhone(line.cardId, brigadeOnly, openedId))
      )
        intent.ownPath = `/arm/cards/${encodeURIComponent(line.cardId)}`;
      if (!current()) return;
      if (line.kind === "control") {
        setControlLine({
          cardId: line.cardId,
          callId: line.callId,
          resumed: true,
          onResume: () => {
            if (!current() || !hold.acceptResume(line.callId, () => true))
              return false;
            void realtime.enqueue(
              line.cardId,
              holdMark("call_resume", line.callId),
            );
            return true;
          },
        });
        phone.show();
      } else
        requestLine({
          kind: "resume",
          cardId: line.cardId,
          callId: line.callId,
          phoneExt: line.phoneExt,
          saved: line.saved ?? null,
          accept: (start) => {
            if (!current()) return false;
            if (!hold.acceptResume(line.callId, start)) return false;
            void realtime.enqueue(
              line.cardId,
              holdMark("call_resume", line.callId),
            );
            return true;
          },
        });
      if (!current()) return;
      if (line.kind === "control") {
        if (openedId !== line.cardId) goToCard(line.cardId, version);
      } else talkOn(line.cardId, version);
    })();
  });
  const phone = usePhoneState(rings, missed, hold.state, controls, controlLine);
  // Линия в окне телефона: отмечаем, что разговор шёл, и отпускаем её, когда открытой
  // другой карточке нужна своя связь.
  const callActive = phone.call !== null;
  useEffect(() => {
    if (!phoneLine) return;
    if (lineReleased(phoneLine, callActive, openedId)) setPhoneLine(null);
    else {
      const next = noteTalk(phoneLine, callActive);
      if (next !== phoneLine) setPhoneLine(next);
    }
  }, [phoneLine, callActive, openedId]);
  // Разговор по карточке вызова: в финальной смене — в окне телефона, карточку обучаемый
  // находит сам по номеру бригады (решение 18.10); иначе открывается карточка вызова.
  function talkOn(cardId: string, resumeVersion?: number) {
    if (talksInPhone(cardId, brigadeOnly, openedId)) {
      setPhoneLine({ cardId, openedAt: openedId, talked: false });
      return;
    }
    setPhoneLine(null);
    if (openedId !== cardId) goToCard(cardId, resumeVersion);
  }
  // Освободить линию для другой (вкладки 17.10): идущий разговор встаёт на удержание, а не
  // обрывается; не удержать (набор, гудки, прощание) — кладётся трубка.
  async function freeLine(): Promise<void> {
    resumeVersion.current += 1;
    resumeIntent.current = null;
    cancelLine();
    if (
      controlLine?.resumed &&
      hold.state.held.some((line) => line.callId === controlLine.callId)
    )
      setControlLine(null);
    const call = activeCall();
    if (!call) return;
    const line = call.hold?.() ?? null;
    if (!line) {
      await call.hangup();
      return;
    }
    hold.dispatch({ type: "hold", line, at: Date.now() });
    const mark = holdMark("call_hold", line.callId);
    void realtime.enqueue(line.cardId, {
      ...mark,
      type: "call_hold",
      payload: {
        call_id: line.callId,
        ...(line.saved?.report ? reportPayload(line.saved.report) : {}),
      },
    });
    if (line.kind === "control") setControlLine(null);
  }
  // «Удержать» на плашке линий: разговор ждёт, линия свободна.
  function holdCall() {
    void freeLine();
  }
  // Вкладка звонящей бригады (DT-20, TC-02, вкладки 17.10): идущий разговор — на удержание,
  // открывается карточка вызова (в финальной смене — нет), её софтфон снимает трубку.
  async function answerRing(cardId: string, callId: string) {
    stopCallSignal();
    await freeLine();
    requestPickup(cardId, callId);
    talkOn(cardId);
  }
  // Вкладка удержанной линии: идущий разговор — на удержание, эта линия снова на связи.
  const changingLine = useRef(false);
  async function resumeLine(callId: string) {
    if (
      changingLine.current ||
      !hold.state.held.some((line) => line.callId === callId)
    )
      return;
    changingLine.current = true;
    try {
      await freeLine();
      hold.dispatch({ type: "resume", callId, at: Date.now() });
    } finally {
      changingLine.current = false;
    }
  }
  // Ответ отделу контроля (TC-07): идущий разговор — на удержание, открывается карточка, о
  // которой спрашивают; разговор — в окне телефона (phone/ControlTalk.tsx).
  async function answerControl(cardId: string, callId: string) {
    stopCallSignal();
    await freeLine();
    void realtime.enqueue(cardId, {
      client_event_id: crypto.randomUUID(),
      client_ts: new Date().toISOString(),
      type: "call_answer",
      payload: { call_id: callId },
    });
    setControlLine({ cardId, callId });
    phone.show();
    if (openedId !== cardId) goToCard(cardId);
  }
  // Перезвон по пропущенному вызову (TC-02): звонок из карточки этого вызова; идущий
  // разговор — на удержание.
  async function callBack(cardId: string, phoneExt: string) {
    await freeLine();
    requestLine({ kind: "dial", cardId, phoneExt });
    talkOn(cardId);
  }
  const openReview = (cardId: string) => {
    setReviewId(cardId);
    navigate("/arm/results");
  };
  const serviceForIntro =
    (opened ? openedContext.participant : context.participant)
      ?.dds_service_id ?? null;
  const introService = services.data?.find(
    (service) => service.id === serviceForIntro,
  );

  const workspace = (
    <TrainerProvider onReview={openReview}>
      <PhoneContext.Provider value={linkShown ? phone : undefined}>
        <div className={linkShown ? styles.work : undefined}>
          <main
            ref={page}
            tabIndex={-1}
            className={openedId ? styles.cardPage : styles.arm}
            data-trainer-block=""
          >
            <IncidentTabs
              cards={cards.data ?? []}
              now={now}
              openedId={openedId}
              listActive={isList}
              onList={() => (openedId ? closePage() : navigate("/arm"))}
              onOpen={openCard}
            />
            <ReferenceAccess
              sessionId={
                opened && runningIds.includes(opened.session_id)
                  ? opened.session_id
                  : undefined
              }
              running={hasRunningSession}
            />
            <ParallelNotice />
            <ScreenShareBar />
            {switching && (
              <SwitchCallDialog
                label={switching.call.label}
                onConfirm={async () => {
                  const next = switching;
                  setSwitching(null);
                  await next.call.hangup();
                  next.go();
                }}
                onCancel={() => setSwitching(null)}
              />
            )}
            <div className={styles.feedback}>
              <PendingActions />
            </div>
            <TeacherMessages />
            <div hidden={!isList}>
              {/* Поиск и часы — arm_dds/02–05. Строка «Поиск происшествий» — само поле
                поиска; «расширенный по параметрам» в тренажёре без действия. */}
              <div className={styles.top}>
                <section className={styles.search} data-help="arm-search">
                  <div className={styles.searchTitle}>
                    <input
                      ref={searchInput}
                      value={search}
                      onChange={(event) => changeSearch(event.target.value)}
                      onKeyDown={(event) => {
                        if (listKey(event.key, true) !== "firstRow") return;
                        const first =
                          table.current?.querySelector<HTMLElement>(
                            "[data-card-id]",
                          );
                        if (!first) return;
                        event.preventDefault();
                        first.focus();
                      }}
                      placeholder="Поиск происшествий"
                      aria-label="Поиск происшествий"
                      className={styles.searchInput}
                    />
                    <ArmIcon name="lens" className={styles.lens} />
                  </div>
                  <div className={styles.searchRow}>
                    <span aria-hidden="true">
                      расширенный по параметрам{" "}
                      <ArmIcon name="down" size="tiny" />
                    </span>
                    <button
                      type="button"
                      className={styles.reset}
                      onClick={() => changeSearch("")}
                    >
                      сбросить
                    </button>
                  </div>
                </section>
                <div className={styles.clock} data-help="arm-clock">
                  <div className={styles.clockDate}>
                    <b>{clockDate(new Date(now))},</b>
                    {/* В АРМ здесь пользователь (arm_dds/02); в тренажёре — своя служба
                      из занятия: от неё зависит, по какой плитке ставить статус. */}
                    <span>
                      {ownServiceLabel} <ArmIcon name="monitor" size="tiny" />
                      <ArmIcon name="gear" size="tiny" />
                      <ArmIcon name="help" size="tiny" />
                    </span>
                  </div>
                  <div className={styles.clockTime}>
                    {clock.hm}
                    <sup>{clock.s}</sup>
                  </div>
                </div>
              </div>

              <section className={styles.list} data-help="arm-list">
                <div className={styles.listHead} data-help="arm-list-head">
                  <h2>
                    Список происшествий <ArmIcon name="up" size="tiny" />
                  </h2>
                  {/* Учебные кнопки — в шапке списка, одной группой в порядке пути
                    обучаемого. Колонку тренажёра убрали по проверке 17.10. */}
                  <div className={styles.actions}>
                    <PracticeButton
                      step={trainingStep(progress.data)}
                      label={trainingLabel(progress.data)}
                      helpKey="tool-practice"
                    />
                    {/* Этапы обучения — пока обучаемый на ступени 1 (решение 17.10). */}
                    {showsStages(progress.data, progress.isError) && (
                      <StageSwitch />
                    )}
                    <MentorButton />
                    <ProgressButton />
                    <CatalogButton />
                    <WarmupButton />
                    <HeadsetButton className={styles.resultsButton} />
                    <button
                      type="button"
                      className={styles.resultsButton}
                      data-help="tool-results"
                      onClick={() => navigate("/arm/results")}
                    >
                      Мои результаты
                    </button>
                    <button
                      type="button"
                      className={styles.resultsButton}
                      data-help="tool-reference"
                      onClick={() => navigate("/arm/reference")}
                    >
                      Справка
                    </button>
                  </div>
                  <PracticeAvailabilityNotice />
                  <span className={styles.tools} aria-hidden="true">
                    <span>
                      <ArmIcon name="info" size="tiny" /> уведомления
                    </span>
                    <span className={styles.fakeSelect}>
                      выберите что показать <small>▴</small>
                    </span>
                  </span>
                </div>
                {cards.isError && (
                  <p role="alert">
                    Не удалось загрузить происшествия.{" "}
                    <button
                      disabled={cards.isFetching}
                      title={
                        cards.isFetching ? "Список уже загружается" : undefined
                      }
                      onClick={() => void cards.refetch()}
                    >
                      Повторить
                    </button>
                  </p>
                )}
                <ParallelBanner />
                {cards.isPending && <p>Загрузка…</p>}
                <div className={styles.tableWrap} ref={table}>
                  <table className={styles.table}>
                    <thead data-help="arm-columns">
                      <tr>
                        {COLUMNS.map((column, index) => (
                          <th
                            key={index}
                            className={
                              column.optional ? styles.optional : undefined
                            }
                          >
                            {column.title}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {isList &&
                        pageRows.map((row) =>
                          row.kind === "card" ? (
                            <IncidentRow
                              key={row.item.id}
                              card={row.item}
                              services={services.data ?? []}
                              now={now}
                              onOpen={() => openCard(row.item.id)}
                            />
                          ) : (
                            <BackgroundRow
                              key={row.item.id}
                              item={row.item}
                              services={services.data ?? []}
                              now={now}
                            />
                          ),
                        )}
                    </tbody>
                  </table>
                </div>
                {cards.isSuccess && visible.length === 0 && (
                  <p role="status">
                    {emptyListText(
                      search,
                      hasRunningSession,
                      trainingStep(progress.data),
                      background.length > 0,
                    )}
                  </p>
                )}
                {/* Пагинация — arm_dds/02, 03: номер страницы, «Записей на странице»,
                  «1-10 из N» и стрелки соседних страниц. */}
                <div className={styles.pager} data-help="arm-pager">
                  <label className={styles.pagerField}>
                    Страница:
                    <span className={styles.pagerSelect}>
                      <select
                        value={pager.pages ? pager.page + 1 : ""}
                        disabled={!pager.pages}
                        onChange={(event) =>
                          setPageNo(Number(event.target.value) - 1)
                        }
                      >
                        {Array.from({ length: pager.pages }, (_, index) => (
                          <option key={index} value={index + 1}>
                            {index + 1}
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                  <label className={styles.pagerField}>
                    Записей на странице:
                    <span className={styles.pagerSelect}>
                      <select
                        value={pageSize}
                        onChange={(event) => {
                          setPageSize(Number(event.target.value));
                          setPageNo(0);
                        }}
                      >
                        {PAGE_SIZES.map((size) => (
                          <option key={size} value={size}>
                            {size}
                          </option>
                        ))}
                      </select>
                    </span>
                  </label>
                  <b className={styles.pagerCount}>{pager.label}</b>
                  {/* aria-disabled, а не disabled: дойдя до крайней страницы, стрелка
                    остаётся в фокусе, и Tab не уводит в начало экрана. */}
                  <span className={styles.pagerArrows}>
                    <button
                      type="button"
                      className={styles.pagerArrow}
                      aria-label="Предыдущая страница"
                      title="Предыдущая страница"
                      aria-disabled={pager.page === 0}
                      onClick={() => {
                        if (pager.page > 0) setPageNo(pager.page - 1);
                      }}
                    >
                      <ArmIcon name="left" />
                    </button>
                    <button
                      type="button"
                      className={styles.pagerArrow}
                      aria-label="Следующая страница"
                      title="Следующая страница"
                      aria-disabled={pager.page >= pager.pages - 1}
                      onClick={() => {
                        if (pager.page < pager.pages - 1)
                          setPageNo(pager.page + 1);
                      }}
                    >
                      <ArmIcon name="right" />
                    </button>
                  </span>
                </div>
              </section>
            </div>

            {opened && (
              <IncidentCard
                key={opened.id}
                card={opened}
                softphone={lineCard?.id !== opened.id}
                softphoneInPhone={openedInPhone(
                  lineCard?.id ?? null,
                  lineShown,
                )}
                services={services.data ?? []}
                onClose={closePage}
                onReview={() => {
                  setReviewId(opened.id);
                  navigate("/arm/results");
                }}
              />
            )}
            {openedId && !opened && (
              <section className={styles.unavailable}>
                <p role={cards.isPending ? "status" : "alert"}>
                  {cards.isPending
                    ? "Загружаем карточку…"
                    : cards.isError
                      ? "Не удалось загрузить карточку. Проверьте соединение."
                      : "Карточка не найдена или недоступна."}
                </p>
                {cards.isError && (
                  <button onClick={() => void cards.refetch()}>
                    Повторить
                  </button>
                )}
                <button onClick={closePage}>К списку происшествий</button>
              </section>
            )}

            {reference && <ReferencePanel onClose={closePage} />}

            {results && (
              <ResultsPanel
                initialCardId={reviewId}
                services={services.data ?? []}
                onClose={closePage}
              />
            )}
          </main>
          {/* Тренажёр (решение 17.10): в обучении — подсказка у элемента шага, на тестах
              — ничего. Строка обрыва связи — во всех режимах. */}
          {linkShown && (
            <TrainerCoach
              cards={cards.data ?? []}
              now={now}
              reactionS={REACTION_S}
            />
          )}
          {linkShown && <ConnectionNotice now={now} />}
        </div>
        {linkShown && (
          <PhoneWindow
            title={`Телефон · ${serviceLabel(services.data, linkServiceId)}`
              .replace(/ · $/, "")
              .trim()}
            own={ownNumber(
              services.data?.find((service) => service.id === linkServiceId),
              (opened ? openedContext.participant : listContext.participant)
                ?.workstation_number,
            )}
            brigadeOnly={brigadeOnly}
            away={!opened && !lineCard}
            onAnswer={(cardId, callId) => void answerRing(cardId, callId)}
            onHold={holdCall}
            onResume={(callId) => void resumeLine(callId)}
            onCallback={(cardId, ext) => void callBack(cardId, ext)}
            onAnswerControl={(cardId, callId) =>
              void answerControl(cardId, callId)
            }
            control={
              controlLine && (
                <ControlTalk
                  key={controlLine.callId}
                  cardId={controlLine.cardId}
                  callId={controlLine.callId}
                  resumed={controlLine.resumed === true}
                  onResume={controlLine.onResume}
                  line={
                    controls.find(
                      (line) => line.control.call_id === controlLine.callId,
                    ) ?? null
                  }
                  onDone={() => setControlLine(null)}
                />
              )
            }
            idle={
              <IdleContacts
                serviceId={linkServiceId}
                services={services.data ?? []}
                contacts={contactsFor(linkSettings, linkServiceId)}
              />
            }
          />
        )}
        {lineCard && (
          <CardLine
            card={lineCard}
            callOnly={opened?.id !== lineCard.id}
            onCallShown={setLineShown}
          />
        )}
      </PhoneContext.Provider>
      {finalShift && (
        <MemoryCheckWindow
          key={finalShift.id}
          sessionId={finalShift.id}
          cards={finalCards}
          expected={Number(finalShift.settings_snapshot.parallel_cards ?? 1)}
          talking={callActive || controlLine !== null}
          ringing={
            phone.rings.length > 0 ||
            phone.controls.some((line) => controlRinging(line.control))
          }
        />
      )}
      <TrainerDialogs
        service={introService ? introService.name : null}
        workstation={
          (opened ? openedContext.participant : context.participant)
            ?.workstation_number ?? null
        }
        reactionS={REACTION_S}
        pathStep={trainingStep(progress.data)}
        onReview={openReview}
        onMenu={() => (openedId ? closePage() : navigate("/arm"))}
      />
      {/* Обучение по интерфейсу: предложить один раз — на списке, новичку (ступень 1). */}
      <InterfaceTour
        offer={
          isList &&
          helpEnabled &&
          progress.isSuccess &&
          showsStages(progress.data)
        }
      />
    </TrainerProvider>
  );
  return (
    <CardToolsProvider
      key={user.id}
      store={tools}
      now={now}
      cards={cards.data ?? []}
      openedId={openedId}
      onOpen={openCard}
    >
      {workspace}
    </CardToolsProvider>
  );
}
