// Экран оператора 112 — вёрстка по docs/screenshots/card_112/01–03.
// Этап 3 (docs/operator_112_review/PLAN.md): выбор звонка перед приёмом, справка «?»
// (OPERATOR_GUIDE), проводник первого звонка, разбор звонка после «сохранить» и
// «Пройти заново» — тот же звонок с начала.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { useHelpGuide, useHelpState } from "../shared/help/HelpProvider";
import { useSession } from "../shared/session";
import { OPERATOR_DATA as data, type CallScenario } from "./data";
import {
  EMPTY_ADDRESS,
  FREQUENT_TYPES,
  DESCRIPTION_LIMIT,
  OPERATOR_SETTINGS,
  activeTags,
  addressLine,
  autoServices,
  barServices,
  descriptionCounter,
  formatPhone,
  formatTimer,
  frequentChoice,
  isOverdue,
  keepQuickTags,
  saveServices,
  searchServices,
  searchTypes,
  tagGroups,
  toggleTag,
  type Address,
  type Answers,
  type Choice,
} from "./model";
import {
  ENDED,
  START_PROGRESS,
  startState,
  type CallerState,
  type Progress,
} from "./dialog";
import { createTones } from "../arm/softphone/tones";
import styles from "./OperatorPage.module.css";
import { Talk } from "./Talk";
import { useTalkWindow } from "./useTalkWindow";
import {
  cardAnswer,
  cardType,
  cardGroups,
  cardTitle,
  displayServices,
  groupChoice,
  SERVICE_LABELS,
  SERVICE_ORDER,
  DIALOG_ORDER,
  TYPE_GROUPS,
} from "./presentation";
const SERVICES = displayServices(data.services);
const DIALOG_SERVICES = [...SERVICES].sort(
  (a, b) => DIALOG_ORDER.indexOf(a.id) - DIALOG_ORDER.indexOf(b.id),
);
import { OperatorResults } from "./OperatorResults";
import { RESULTS_PATH } from "./results";
import { Review } from "./Review";
import { GuideBubble } from "./GuideBubble";
import { nextTip, tipForCollapsed } from "./guide";
import { OPERATOR_GUIDE } from "./help/topics";
import { EMPTY_JOURNAL, closeJournal, type CallJournal } from "./journal";
import {
  cardInput,
  fetchAttempts,
  saveAttempt,
  type AttemptResult,
  type AttemptSummary,
} from "./save";
import {
  AlertMessageIcon,
  BellIcon,
  CloseIcon,
  GlobeIcon,
  HandIcon,
  MapIcon,
  PhoneIcon,
  PinIcon,
  QuestionIcon,
  SmsIcon,
  StopwatchIcon,
  TranslateIcon,
  UnlinkIcon,
} from "./icons";

function Phone({
  label,
  value,
  onChange,
  onAon,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  onAon?: () => void;
}) {
  return (
    <div className={styles.phone}>
      <span className={styles.phoneIcon}>
        <PhoneIcon />
        <SmsIcon />
      </span>
      <label className={onChange ? styles.phoneField : styles.phoneMain}>
        <span className={styles.phoneLabel}>
          {label}
          <span className={styles.phoneMarks} aria-hidden="true">
            {!onChange && (
              <>
                <QuestionIcon />
                <PinIcon />
              </>
            )}
            <GlobeIcon />
          </span>
        </span>
        <input
          value={value}
          placeholder="+7 (   )    -  -"
          readOnly={!onChange}
          onChange={(event) => onChange?.(event.target.value)}
        />
      </label>
      {onAon && (
        <button type="button" className={styles.aon} onClick={onAon}>
          АОН
        </button>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  wide,
  list,
  guide,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  wide?: boolean;
  /** Поле-список со стрелкой, как «Округ» и «Район». */
  list?: boolean;
  /** Сюда может указать проводник (`data-guide`). */
  guide?: string;
}) {
  return (
    <label
      className={
        wide ? styles.fieldWide : list ? styles.fieldList : styles.field
      }
      data-guide={guide}
    >
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

// Сетка строк — по card_112/01: ширины колонок в долях строки адреса,
// хвост у двух нижних строк пустой.
const ADDRESS_ROWS: {
  columns: string;
  fields: [keyof Address, string][];
}[] = [
  {
    columns: "1fr 1fr 2fr",
    fields: [
      ["country", "Страна:"],
      ["subject", "Субъект:"],
      ["locality", "Населенный пункт:"],
    ],
  },
  {
    columns: "2fr 1fr 1fr",
    fields: [
      ["object", "Объект:"],
      ["okrug", "Округ:"],
      ["district", "Район:"],
    ],
  },
  {
    columns: "3fr 1fr 1fr 1fr",
    fields: [
      ["street", "Улица:"],
      ["house", "Дом/Вл:"],
      ["korpus", "Корпус:"],
    ],
  },
  {
    columns: "1fr 1fr 1fr 1fr 1fr 1fr",
    fields: [
      ["structure", "Стр/соор:"],
      ["apartment", "Квартира/офис:"],
      ["entrance", "Подъезд:"],
      ["floor", "Этаж:"],
      ["code", "Код:"],
    ],
  },
];
const LIST_FIELDS: ReadonlySet<keyof Address> = new Set(["okrug", "district"]);

function Toggle({
  pressed,
  onClick,
  className,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  className: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ServicesDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: ReadonlySet<string>;
  onSave: (checked: Set<string>) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState(() => new Set(initial));
  return (
    <div className={styles.backdrop}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="operator-services-title"
        className={styles.dialog}
      >
        <button
          type="button"
          className={styles.dialogClose}
          aria-label="Закрыть"
          onClick={onClose}
        >
          ×
        </button>
        <h2 id="operator-services-title">Добавьте службы</h2>
        <input
          className={styles.dialogSearch}
          placeholder="Поиск ..."
          aria-label="Поиск"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className={styles.dialogList}>
          {searchServices(DIALOG_SERVICES, query).map((service) => (
            <li key={service.id}>
              <button
                type="button"
                aria-pressed={checked.has(service.id)}
                onClick={() =>
                  setChecked((current) => {
                    const next = new Set(current);
                    if (!next.delete(service.id)) next.add(service.id);
                    return next;
                  })
                }
              >
                {service.name}
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={styles.dialogSave}
          onClick={() => onSave(checked)}
        >
          Сохранить и закрыть
        </button>
      </div>
    </div>
  );
}

// Элементы со скриншотов card_112 без действия в тренажёре: видны для сходства, но
// неактивны и честно подписаны (разбор 29.09, п. 4).
const UNUSED = "В тренажёре не используется";

// Крестик внизу справа закрывает карточку — возврат туда, откуда пришли.
function formatCreated(time: number): string {
  const date = new Date(time);
  return `${date.toLocaleDateString("ru-RU")} в ${date.toLocaleTimeString("ru-RU")}`;
}

/** Подсказка о паузе — первые секунды после первого «Алло?», не дольше. */
const PAUSE_TIP_S = 9;

function lastSilence(journal: CallJournal): number | null {
  for (let i = journal.events.length - 1; i >= 0; i--)
    if (journal.events[i]!.action === "silence") return journal.events[i]!.t;
  return null;
}

/**
 * Страница звонка: какой звонок принять (выбор до приёма — учебное дополнение), приём
 * вызова и экран. Экран — отдельный компонент с ключом: «Пройти заново» и смена звонка
 * начинают его с чистого листа.
 */
/** Модуль «Оператор 112»: звонок и экран результатов, куда ведёт выход из 112. */
export function OperatorPage() {
  return (
    <Routes>
      <Route path="results" element={<OperatorResults />} />
      <Route path="*" element={<OperatorCall />} />
    </Routes>
  );
}

function OperatorCall() {
  const [params, setParams] = useSearchParams();
  // Без ?scenario= звонит случайный заявитель из учебных сценариев.
  const [randomIndex] = useState(() =>
    Math.floor(Math.random() * data.scenarios.length),
  );
  const chosen = data.scenarios.find(
    (item) => item.id === params.get("scenario"),
  );
  const scenario = chosen ?? data.scenarios[randomIndex];
  // Таймер идёт с момента, когда оператор принял вызов (этап 2).
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [run, setRun] = useState(0);
  // Проводник включён у каждого нового звонка (просьба капитана 29.09); «Скрыть проводник»
  // и снятая галочка действуют только на этот звонок.
  const [guideOn, setGuideOn] = useState(true);
  const accepted = startedAt !== null;
  const tones = useMemo(() => createTones(), []);
  useHelpGuide(OPERATOR_GUIDE);
  useEffect(() => {
    if (accepted) return;
    // Звонок идёт, пока его не приняли; без жеста пользователя браузер может промолчать.
    tones.ringback();
    return () => tones.stop();
  }, [accepted, tones]);
  useEffect(() => () => tones.close(), [tones]);
  if (!scenario) return null;
  const aon = formatPhone(scenario.caller.phone);
  const choose = (id: string | null) =>
    setParams(id ? { scenario: id } : {}, { replace: true });

  return (
    <>
      <CallScreen
        key={`${scenario.id}:${run}`}
        scenario={scenario}
        startedAt={startedAt}
        guideOn={guideOn}
        onGuideOff={() => setGuideOn(false)}
        onRestart={() => {
          // Тот же звонок с начала: снова «Входящий вызов», звук — после «Принять вызов».
          choose(scenario.id);
          setStartedAt(null);
          setGuideOn(true);
          setRun((value) => value + 1);
        }}
      />
      {/* Входящий вызов (этап 2): приём — жест пользователя, без него браузер не даст звук. */}
      {!accepted && (
        <div className={styles.backdrop}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="operator-incoming-title"
            className={styles.incoming}
          >
            <span className={styles.ring} aria-hidden="true">
              <PhoneIcon />
            </span>
            <h2 id="operator-incoming-title">Входящий вызов 112</h2>
            <p className={styles.incomingNumber}>{aon}</p>
            {/* Этап 3: учебный выбор — случайный звонок или конкретный персонаж. */}
            <fieldset className={styles.incomingChoice}>
              <legend>Кто звонит</legend>
              <label>
                <input
                  type="radio"
                  name="operator-call"
                  checked={!chosen}
                  onChange={() => choose(null)}
                />
                Случайный звонок
              </label>
              {data.scenarios.map((item) => (
                <label key={item.id}>
                  <input
                    type="radio"
                    name="operator-call"
                    checked={chosen?.id === item.id}
                    onChange={() => choose(item.id)}
                  />
                  {item.persona.label}
                </label>
              ))}
            </fieldset>
            <label className={styles.incomingGuide}>
              <input
                type="checkbox"
                checked={guideOn}
                onChange={(event) => setGuideOn(event.target.checked)}
              />
              Проводник: подсказка на каждом шаге
            </label>
            <p>
              Примите вызов — заявитель заговорит сразу. Лучше в наушниках: в
              трубке слышен фон.
            </p>
            <button
              type="button"
              className={styles.accept}
              autoFocus
              onClick={() => {
                tones.stop();
                setStartedAt(Date.now());
              }}
            >
              Принять вызов
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function CallScreen({
  scenario,
  startedAt,
  guideOn,
  onGuideOff,
  onRestart,
}: {
  scenario: CallScenario;
  startedAt: number | null;
  guideOn: boolean;
  onGuideOff: () => void;
  onRestart: () => void;
}) {
  const { user } = useSession();
  const navigate = useNavigate();
  // Пока открыта справка «?», проводник молчит: у экрана одно объяснение за раз (прототип).
  const help = useHelpState();
  const aon = formatPhone(scenario.caller.phone);
  const [number] = useState(() => String(Date.now()).slice(-8));
  const [createdAt] = useState(() => Date.now());
  const accepted = startedAt !== null;
  useEffect(() => {
    const previous = document.title;
    document.title = `Происшествие ${number}`;
    return () => {
      document.title = previous;
    };
  }, [number]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed =
    startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
  const [minutes, seconds] = formatTimer(elapsed);

  const [provided, setProvided] = useState("");
  const [onSite, setOnSite] = useState("");
  const [caller, setCaller] = useState("");
  const [address, setAddress] = useState<Address>(EMPTY_ADDRESS);
  const [description, setDescription] = useState("");
  const [flags, setFlags] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [typeFocused, setTypeFocused] = useState(false);
  const talkWindow = useTalkWindow();
  const talkCollapsed = talkWindow.collapsed;
  const serviceStrip = useRef<HTMLUListElement>(null);
  const [servicesOverflow, setServicesOverflow] = useState(false);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState(false);
  // «нет контакта» и «срыв звонка» заканчивают разговор насовсем.
  const [ended, setEnded] = useState<string | null>(null);
  const [dialogState, setDialogState] = useState<CallerState>(() =>
    startState(scenario),
  );
  const [progress, setProgress] = useState<Progress>(START_PROGRESS);
  const [journal, setJournal] = useState<CallJournal>(EMPTY_JOURNAL);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [attempts, setAttempts] = useState<AttemptSummary[]>([]);
  const onTalkState = useCallback((state: CallerState, next: Progress) => {
    setDialogState(state);
    setProgress(next);
  }, []);

  const type =
    choice?.kind === "type"
      ? data.types.find((item) => item.code === choice.code)
      : undefined;
  const tags = activeTags(answers);
  const auto = autoServices(data, type?.code ?? null, tags);
  const onBar = barServices(SERVICES, auto, added, removed).sort(
    (a, b) => SERVICE_ORDER.indexOf(a.id) - SERVICE_ORDER.indexOf(b.id),
  );
  useLayoutEffect(() => {
    const strip = serviceStrip.current;
    if (!strip) return;
    const measure = () =>
      setServicesOverflow(strip.scrollWidth > strip.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    measure();
    return () => observer.disconnect();
  }, [onBar.length]);
  const found = useMemo(() => searchTypes(data, query), [query]);
  const groups = type ? cardGroups(data, type, answers) : [];
  const routingGroups = type ? tagGroups(data, type, answers) : [];
  const flag = (key: string) => () => {
    if (key in ENDED && !flags.has(key)) setEnded((current) => current ?? key);
    setFlags((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };
  const setPart = (key: keyof Address) => (value: string) =>
    setAddress((current) => ({ ...current, [key]: value }));
  const choose = (next: Choice) => {
    setChoice(next);
    setQuery("");
    setTypeFocused(false);
  };
  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const card = cardInput({
        incidentTypeCode: type?.code ?? null,
        tags,
        services: onBar.map((service) => service.id),
        address,
        description,
        callerName: caller,
        phoneProvided: provided,
        phoneScene: onSite,
        offSite: flags.has("off_site"),
      });
      // Секунды — по часам в момент сохранения: таймер экрана тикает раз в секунду.
      const at =
        startedAt === null ? 0 : Math.floor((Date.now() - startedAt) / 1000);
      const saved = await saveAttempt(
        scenario.id,
        dialogState,
        elapsed,
        card,
        closeJournal(journal, at, ENDED.saved!),
      );
      setResult(saved);
      // Сохранили карточку — упражнение окончено, заявитель больше не звонит.
      setEnded((current) => current ?? "saved");
      setAttempts(await fetchAttempts());
    } catch {
      setSaveError("Не удалось сохранить карточку. Попробуйте ещё раз.");
    } finally {
      setSaving(false);
    }
  };

  // Проводник первого звонка (этап 3): одна подсказка — на следующий шаг.
  const silence = lastSilence(journal);
  const tip =
    guideOn && accepted && !result
      ? nextTip({
          talking: ended === null,
          saved: ended === "saved",
          state: dialogState,
          progress,
          pauseJustHappened:
            dialogState.pauses === 1 &&
            silence !== null &&
            elapsed - silence < PAUSE_TIP_S,
          card: {
            street: address.street,
            typeChosen: Boolean(type),
            selectingType: typeFocused || query !== "",
            // Группы с выбором «да/нет»; «Доступ» — одна кнопка: отмечают, только если нет доступа.
            tagsAnswered: routingGroups
              .filter(
                (group) =>
                  !group.key.startsWith("sign") && group.options.length > 1,
              )
              .every((group) => answers[group.key] !== undefined),
            description,
          },
        })
      : null;
  const shownTip = tipForCollapsed(tip, talkCollapsed);

  return (
    <div className={styles.page} data-collapsed={talkCollapsed}>
      <header className={styles.top} data-help="operator-header">
        <div className={styles.hangup}>
          <span className={styles.hangupIcon} aria-hidden="true">
            <PhoneIcon />
          </span>
          <div>
            <p>Отключение</p>
            <button type="button" disabled title={UNUSED}>
              записи звонков
            </button>
            <button type="button" disabled title={UNUSED}>
              список SMS
            </button>
          </div>
        </div>
        <Phone label="АОН" value={aon} />
        <Phone
          label="предоставленный"
          value={provided}
          onChange={setProvided}
          onAon={() => setProvided(aon)}
        />
        <Phone
          label="телефон на место"
          value={onSite}
          onChange={setOnSite}
          onAon={() => setOnSite(aon)}
        />
        <div className={styles.incident}>
          <h1>Происшествие {number}</h1>
          <p>Сохр. {formatCreated(createdAt)}</p>
          <p>Опер., АРМ {user.workstation_number ?? 4}, УМЦ 0 п</p>
        </div>
        <div
          className={
            isOverdue(elapsed, OPERATOR_SETTINGS.timerWarningS)
              ? styles.timerOverdue
              : styles.timer
          }
          role="timer"
          aria-label={`Время ${minutes}:${seconds}`}
        >
          <strong>
            {minutes}:{seconds}
          </strong>
          <span>минут</span>
          <span>секунд</span>
        </div>
      </header>

      <section className={styles.left}>
        <div className={styles.caller} data-help="operator-caller">
          <input
            placeholder="Фамилия и имя заявителя"
            aria-label="Фамилия и имя заявителя"
            value={caller}
            onChange={(event) => setCaller(event.target.value)}
          />
          <select
            aria-label="Статус заявителя"
            defaultValue=""
            disabled
            title={UNUSED}
          >
            <option value="" disabled>
              выберите статус
            </option>
          </select>
          <select
            aria-label="Язык заявителя"
            defaultValue=""
            disabled
            title={UNUSED}
          >
            <option value="" />
          </select>
          <select
            aria-label="Категория заявителя"
            defaultValue=""
            disabled
            title={UNUSED}
          >
            <option value="" />
          </select>
          <button
            type="button"
            className={styles.translate}
            aria-label="Переводчик"
            disabled
            title={UNUSED}
          >
            <TranslateIcon />
          </button>
        </div>
        <div className={styles.address} data-help="operator-address">
          <div className={styles.addressLine}>
            <span className={styles.addressLabel}>
              Адрес:{" "}
              <span title={UNUSED} aria-disabled="true">
                <MapIcon />
              </span>
            </span>
            <p>{addressLine(address)}</p>
            <button
              type="button"
              aria-label="Очистить строку адреса"
              onClick={() => setAddress(EMPTY_ADDRESS)}
            >
              ×
            </button>
          </div>
          {ADDRESS_ROWS.map((row) => (
            <div
              key={row.fields[0]![0]}
              className={styles.addressRow}
              style={{ gridTemplateColumns: row.columns }}
            >
              {row.fields.map(([key, label]) => (
                <Field
                  key={key}
                  label={label}
                  value={address[key]}
                  list={LIST_FIELDS.has(key)}
                  guide={key === "street" ? "street" : undefined}
                  onChange={setPart(key)}
                />
              ))}
            </div>
          ))}
          <Field
            wide
            label="Описательный адрес:"
            value={address.descriptive}
            onChange={setPart("descriptive")}
          />
          <button
            type="button"
            className={styles.clearAddress}
            onClick={() => setAddress(EMPTY_ADDRESS)}
          >
            очистить адрес
          </button>
        </div>
        <label
          className={styles.description}
          data-help="operator-description"
          data-guide="description"
        >
          <span>Описание со слов заявителя</span>
          <textarea
            placeholder="введите"
            maxLength={DESCRIPTION_LIMIT}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <small>{descriptionCounter(description)}</small>
        </label>
      </section>

      <section
        className={styles.right}
        data-fire={type?.signs[0] === "жилой дом"}
      >
        <div className={styles.quick} data-help="operator-quick">
          <div className={styles.quickGroup}>
            <Toggle
              className={styles.quickButton}
              pressed={tags.has("victims")}
              onClick={() => setAnswers((a) => toggleTag(a, "victims"))}
            >
              Пострадавшие
            </Toggle>
            <Toggle
              className={styles.quickButton}
              pressed={flags.has("off_site")}
              onClick={flag("off_site")}
            >
              Нет на месте/
              <br />
              Отказ от скорой
            </Toggle>
            <Toggle
              className={styles.quickButton}
              pressed={tags.has("no_access")}
              onClick={() => setAnswers((a) => toggleTag(a, "no_access"))}
            >
              Нет доступа/
              <br />
              Заблокированные
            </Toggle>
          </div>
          <div className={styles.quickGroup}>
            <Toggle
              className={choice ? styles.alertFaded : styles.alertButton}
              pressed={flags.has("no_contact")}
              onClick={flag("no_contact")}
            >
              нет контакта
            </Toggle>
            <Toggle
              className={choice ? styles.alertFaded : styles.alertButton}
              pressed={flags.has("dropped")}
              onClick={flag("dropped")}
            >
              срыв звонка
            </Toggle>
          </div>
        </div>

        <div
          className={styles.types}
          data-help="operator-type"
          data-chosen={Boolean(choice)}
        >
          <label className={styles.typeSearch} data-guide="type">
            {!choice && <span>Введите тип происшествия</span>}
            <input
              placeholder={
                choice ? "добавить тип происшествия" : "что случилось?"
              }
              aria-label="Тип происшествия"
              value={query}
              onFocus={() => setTypeFocused(true)}
              onBlur={(event) => {
                if (
                  !event.currentTarget
                    .closest('[data-help="operator-type"]')
                    ?.contains(event.relatedTarget)
                )
                  setTypeFocused(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setTypeFocused(false);
                  event.currentTarget.blur();
                }
              }}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {typeFocused && !query && (
            <ul className={styles.found} aria-label="Группы происшествий">
              {[
                ...TYPE_GROUPS,
                ...new Set(
                  data.types
                    .map((t) => t.groupName)
                    .filter((name) => !TYPE_GROUPS.includes(name)),
                ),
              ].map((label) => (
                <li key={label}>
                  <button
                    type="button"
                    onClick={() => {
                      const next = groupChoice(data, label);
                      if (next) {
                        choose({ kind: "type", code: next.code });
                        setAnswers(keepQuickTags);
                      } else
                        setQuery(
                          label ===
                            "Аварии и происшествия в городском хозяйстве"
                            ? "городском хозяйстве"
                            : label,
                        );
                    }}
                  >
                    {label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {found.length > 0 && (
            <ul className={styles.found} aria-label="Найденные типы">
              {found.map((item) => (
                <li key={item.code}>
                  <button
                    type="button"
                    onClick={() => {
                      choose({ kind: "type", code: item.code });
                      setAnswers(keepQuickTags);
                    }}
                  >
                    {item.name}
                    <small>{item.groupName}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!choice && found.length === 0 && (
            <>
              <div className={styles.frequent}>
                {FREQUENT_TYPES.map((label) => (
                  <button
                    key={label}
                    type="button"
                    className={styles.tag}
                    onClick={() => {
                      const result = frequentChoice(data, label);
                      if ("query" in result) setQuery(result.query);
                      else choose(result.choice);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className={styles.significant}>Значимые типы происшествий:</p>
            </>
          )}
        </div>

        {choice && (
          <div
            className={styles.chosen}
            data-help="operator-card"
            data-guide="card"
          >
            <div className={styles.chips}>
              <button
                type="button"
                className={styles.chip}
                onClick={() => {
                  setChoice(null);
                  setAnswers(keepQuickTags);
                }}
                title="Убрать тип происшествия"
              >
                {choice.kind === "call"
                  ? choice.label
                  : type
                    ? cardTitle(type)
                    : ""}
              </button>
            </div>
            {type && (
              <div className={styles.card}>
                <div className={styles.cardHead}>
                  <h2>{cardTitle(type)}</h2>
                  <button
                    type="button"
                    aria-label="Убрать тип происшествия"
                    onClick={() => {
                      setChoice(null);
                      setAnswers(keepQuickTags);
                    }}
                  >
                    ×
                  </button>
                </div>
                {groups.map((group) => (
                  <div
                    key={group.key}
                    className={styles.tagRow}
                    data-field={group.key}
                  >
                    <span>{group.title}</span>
                    <div role="group" aria-label={group.title}>
                      {group.input && (
                        <input
                          aria-label={group.title}
                          value={answers[group.key] ?? ""}
                          onChange={(event) =>
                            setAnswers((a) => ({
                              ...a,
                              [group.key]: event.target.value,
                            }))
                          }
                        />
                      )}
                      {group.options.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={styles.tag}
                          aria-pressed={option.selected}
                          onClick={() => {
                            if (group.key.startsWith("sign") && option.selected)
                              return;
                            setAnswers((a) =>
                              cardAnswer(a, group, option.value),
                            );
                            if (!option.selected) {
                              const next = cardType(
                                data,
                                type,
                                group.key,
                                option.value,
                              );
                              setChoice({ kind: "type", code: next.code });
                            }
                          }}
                        >
                          {option.value}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
      <Talk
        scenario={scenario}
        floating={talkWindow}
        data={data}
        phone={aon}
        accepted={accepted}
        ended={ended}
        address={address}
        onStateChange={onTalkState}
        onJournalChange={setJournal}
      />

      <footer className={styles.bar} data-help="operator-services">
        <span className={styles.barLabel}>Службы:</span>
        <ul
          ref={serviceStrip}
          className={styles.barServices}
          aria-label="Службы"
        >
          {onBar.map((service) => (
            <li key={service.id} data-service={service.id}>
              <PhoneIcon />
              <span>{SERVICE_LABELS[service.id] ?? service.name}</span>
              <button
                type="button"
                aria-label={`Убрать: ${SERVICE_LABELS[service.id] ?? service.name}`}
                onClick={() => {
                  if (added.has(service.id)) {
                    const next = new Set(added);
                    next.delete(service.id);
                    setAdded(next);
                  } else setRemoved(new Set(removed).add(service.id));
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        {servicesOverflow && (
          <button
            type="button"
            className={styles.barScroll}
            aria-label="Прокрутить службы"
            onClick={() => {
              const strip = serviceStrip.current;
              if (strip)
                strip.scrollLeft =
                  strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1
                    ? 0
                    : strip.scrollLeft + 260;
            }}
          >
            <svg width="24" height="30" viewBox="0 0 24 30" aria-hidden="true">
              <path
                d="m5 11 7-7 7 7M5 19l7 7 7-7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={styles.barAdd}
          aria-label="Добавить службы"
          onClick={() => setDialog(true)}
        >
          +
        </button>
        <button
          type="button"
          className={styles.save}
          disabled={saving}
          data-guide="save"
          onClick={() => void handleSave()}
        >
          {saving ? "сохраняю…" : "сохранить"}
        </button>
        <span className={styles.barTools} aria-hidden="true">
          {[
            UnlinkIcon,
            StopwatchIcon,
            HandIcon,
            BellIcon,
            AlertMessageIcon,
          ].map((Icon, index) => (
            <span key={index} title={UNUSED}>
              <Icon />
            </span>
          ))}
        </span>
        <button
          type="button"
          className={styles.barClose}
          aria-label="Закрыть карточку"
          title="Выйти из 112 — к результатам тренировок"
          onClick={() => navigate(RESULTS_PATH)}
        >
          <CloseIcon />
        </button>
        {saveError && <p className={styles.saveError}>{saveError}</p>}
      </footer>

      {dialog && (
        <ServicesDialog
          initial={new Set(onBar.map((service) => service.id))}
          onClose={() => setDialog(false)}
          onSave={(checked) => {
            const next = saveServices(auto, checked);
            setAdded(next.added);
            setRemoved(next.removed);
            setDialog(false);
          }}
        />
      )}

      {result && (
        <Review
          result={result}
          attempts={attempts}
          scenario={scenario}
          onClose={() => setResult(null)}
          onRestart={onRestart}
        />
      )}

      {shownTip && !dialog && !help.open && (
        <GuideBubble tip={shownTip} onHide={onGuideOff} />
      )}
    </div>
  );
}
