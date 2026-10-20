// Правила связи с бригадами без React и сети: что набранный номер значит для
// сервера, в каком состоянии бригады и какие выданные сведения ещё не предъявлены.
//
// Главное ограничение: очередь событий карточки останавливается на первом отказе
// сервера (любой 4xx). Поэтому событие, которое сервер заведомо отклонит, сюда
// не доходит — решение принимается до набора, а не после ответа.
//
// Связь у диспетчера ДДС есть со всеми своими бригадами (28.09): номер бригады не
// «разблокируется» выбором. Ограничено направление — только свободная бригада и
// только после решения реагировать. Ненаправленная бригада на звонок отвечает отказом.

import type { components } from "../../../api-client/schema";
import type { CardState } from "../../cardModel";
import type { Refusal } from "../machine";

type Brigade = components["schemas"]["Brigade"];
type Service = components["schemas"]["Service"];
type CallTarget = components["schemas"]["CallTarget"];
type InformationEvidence = components["schemas"]["InformationEvidence"];

export type DialPlan =
  /** Номер службы: прежнее событие `call_dial`. */
  | { readonly kind: "service"; readonly service: Service }
  /** Прямой номер направленной сюда бригады: событие `call_dial_target`, она доложит. */
  | { readonly kind: "target"; readonly target: CallTarget }
  /**
   * Бригада своей ДДС, но на это происшествие не направлена. Звонок уходит тем же
   * `call_dial_target`: сервер его принимает и записывает тот же отказ
   * (`Call.refusal`), бригада отвечает отказом и не докладывает.
   */
  | {
      readonly kind: "refused";
      readonly target: CallTarget;
      readonly reason: Refusal;
      /** Номер происшествия, где бригада занята; `null` — она свободна. */
      readonly busyOn: string | null;
    }
  /** Номер не обслуживается: сервер ответил бы 422. */
  | { readonly kind: "unknown" };

export function planDial(
  phoneExt: string,
  services: readonly Service[],
  targets: readonly CallTarget[],
  selectedBrigadeIds: readonly string[],
  busy: ReadonlyMap<string, string> = new Map(),
): DialPlan {
  // Номер общего диспетчера совпадает с номером службы — это обычный звонок в службу.
  const target = targets.find(
    (item) =>
      item.is_active && item.brigade_id !== null && item.phone_ext === phoneExt,
  );
  if (target) {
    const brigadeId = target.brigade_id as string;
    if (selectedBrigadeIds.includes(brigadeId))
      return { kind: "target", target };
    const busyOn = busy.get(brigadeId) ?? null;
    return {
      kind: "refused",
      target,
      reason: busyOn === null ? "not_assigned" : "busy",
      busyOn,
    };
  }
  const service = services.find(
    (item) => item.is_active && item.phone_ext === phoneExt,
  );
  return service ? { kind: "service", service } : { kind: "unknown" };
}

/** Номера нет ни в справочнике, ни в списке абонентов ДДС — он не отвечает (GP-09). */
export const UNKNOWN_NUMBER = "Номер недоступен.";

/**
 * Почему доклада не будет и что делать дальше — после отказа бригады. Один текст для
 * пояснения под телефоном и для подсказки «?»: они не должны советовать разное.
 * `listed` — бригада есть в списке панели; иначе направить её нельзя.
 */
export function refusalNote(
  plan: { readonly reason: Refusal; readonly busyOn: string | null },
  decided: boolean,
  listed = true,
): string {
  if (plan.reason === "not_assigned" && !listed)
    return "Эта бригада сейчас не в вашем распоряжении — доклада не будет. Позвоните свободной бригаде из табло сил.";
  if (plan.reason === "busy")
    return `Бригада занята на происшествии ${plan.busyOn ?? ""} — доклада не будет. Позвоните свободной бригаде.`;
  return decided
    ? "Бригада не направлена на это происшествие — доклада не будет. Позвоните ей снова и дайте вводную: адрес и что случилось."
    : "Бригада не направлена на это происшествие — доклада не будет. Сначала поставьте статус «Принята», затем позвоните бригаде снова.";
}

/** Состояние бригады на табло сил: направлена сюда, свободна или занята другим. */
export type BrigadeState = "here" | "free" | "busy";

export interface BoardRow {
  readonly id: string;
  readonly name: string;
  /** Прямой номер бригады; `null` — номера в справочнике нет. */
  readonly ext: string | null;
  readonly state: BrigadeState;
  /** Номер происшествия, где бригада занята. */
  readonly busyOn: string | null;
  /** Когда направленная бригада последний раз была на связи (DT-10); `null` — не было. */
  readonly lastContactAt: string | null;
}

/**
 * Табло сил: каждая доступная бригада с номером и состоянием. Диспетчер видит, кто
 * свободен, заранее — до решения по карточке, как на мониторе своей службы.
 */
export function forcesBoard(
  brigades: readonly Brigade[],
  targets: readonly CallTarget[],
  committed: readonly string[],
  busy: ReadonlyMap<string, string>,
  contacts: ReadonlyMap<string, string | null> = new Map(),
): BoardRow[] {
  return brigades.map((brigade) => {
    const busyOn = busy.get(brigade.id) ?? null;
    const target = targets.find(
      (item) => item.is_active && item.brigade_id === brigade.id,
    );
    return {
      id: brigade.id,
      name: brigade.name,
      ext: target?.phone_ext ?? null,
      state: committed.includes(brigade.id)
        ? "here"
        : busyOn === null
          ? "free"
          : "busy",
      busyOn,
      lastContactAt: contacts.get(brigade.id) ?? null,
    };
  });
}

/**
 * Сколько направленная бригада без связи (DT-10, решение 08.10): сведения мира, как таймер
 * с последнего контакта в системе службы, а не подсказка. `null` — связи ещё не было или
 * бригада на связи сейчас.
 */
export function silenceLabel(
  lastContactAt: string | null | undefined,
  now: number,
): string | null {
  if (!lastContactAt) return null;
  const seconds = Math.floor((now - Date.parse(lastContactAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 1) return null;
  return `без связи ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Ответ бригаде вариантом (DT-10): реплика с вариантами, ещё без ответа. */
export interface BrigadeQuestion {
  readonly deliveryId: string;
  /** Реплика вопроса: снятая с удержания бригада повторяет её (`resumedPhrase`, HQ-058). */
  readonly text: string;
  /** Запись реплики вопроса из сценария (`message.audio`): повтор звучит ею (HQ-058). */
  readonly url: string | null;
  /**
   * Срок ответа (`delivery.reply_by`, мс): до него снятая с удержания бригада повторяет вопрос
   * и придерживает следующую реплику (HQ-058); `null` — срока сервер не отдал.
   */
  readonly replyBy: number | null;
  readonly options: readonly { readonly key: string; readonly label: string }[];
}

/**
 * Вопрос бригады, на который можно ответить в этом разговоре: последняя услышанная
 * реплика той же бригады с вариантами ответа, на которую ещё не ответили.
 * При повторном входящем вызове выдача сохраняет id прежнего звонка.
 */
export function openQuestion(
  messages: readonly InformationEvidence[],
  callId: string | null,
  answered: readonly string[] = [],
  brigadeId: string | null = null,
): BrigadeQuestion | null {
  if (!callId) return null;
  const asked = messages.filter(
    (item) =>
      (brigadeId !== null
        ? item.delivery.brigade_id === brigadeId
        : item.delivery.call_id === callId) &&
      item.state === "presented" &&
      (item.delivery.reply_options?.length ?? 0) > 0 &&
      !item.reply_key &&
      !answered.includes(item.delivery.delivery_id),
  );
  const last = asked[asked.length - 1];
  return last
    ? {
        deliveryId: last.delivery.delivery_id,
        text: last.delivery.message.text,
        url: last.delivery.message.audio?.url ?? null,
        replyBy: last.delivery.reply_by
          ? Date.parse(last.delivery.reply_by)
          : null,
        options: last.delivery.reply_options ?? [],
      }
    : null;
}

export function stateLabel(row: BoardRow): string {
  if (row.state === "here") return "направлена сюда";
  if (row.state === "busy") return `занята: происшествие ${row.busyOn ?? ""}`;
  return "свободна";
}

/** Бригаду направляют после решения реагировать: «Принята» (памятка ДДС, стр. 21). */
const DECIDED: ReadonlySet<CardState> = new Set<CardState>([
  "accepted",
  "responding",
  "arrived",
  "working",
]);

/**
 * Решение по карточке ещё не принято: до «Принята» или после «Не принята». Закрытая
 * карточка решение уже имеет — ей советовать «поставьте «Принята»» нельзя.
 */
export function awaitsDecision(state: CardState | null): boolean {
  return state === "added" || state === "received" || state === "rejected";
}

/** Почему бригаду сейчас не направить; `null` — можно. Сервер отклонил бы выбор. */
export function directBlock(state: CardState | null): string | null {
  if (state === null || DECIDED.has(state)) return null;
  if (state === "added" || state === "received")
    return "Сначала примите решение: поставьте статус «Принята» — после этого позвоните бригаде и дайте вводную.";
  if (state === "rejected")
    return "Карточка не принята — бригады не направляются. Решите реагировать — поставьте «Принята».";
  return "Карточка закрыта — бригады больше не направляются.";
}

/**
 * Сравнение моментов по времени, а не строкой. Сервер пишет «…:16Z» и «…:16.000001Z»: строкой
 * второе раньше первого («.» < «Z»), и доклад, выданный вслед за ответом бригады в ту же
 * секунду, звучал перед ответом (проверка связности 17.10). Совпадение до миллисекунды —
 * порядок сервера (он упорядочивает выдачу до микросекунды), сортировка устойчива.
 */
function byTime(left: string | null, right: string | null): number {
  return (left ? Date.parse(left) : 0) - (right ? Date.parse(right) : 0);
}

/** Выданные, но ещё не предъявленные сведения — в порядке выдачи. */
export function pendingMessages(
  messages: readonly InformationEvidence[],
): InformationEvidence[] {
  return messages
    .filter((item) => item.state !== "presented")
    .sort((left, right) =>
      byTime(left.delivery.delivered_at, right.delivery.delivered_at),
    );
}

/**
 * Последний прозвучавший доклад бригады — то, что она повторит на «доложите обстановку»;
 * null — докладов ещё не было или последний — о выезде (`departure`).
 * Не её вопрос и не ответ на действие диспетчера, и не только в этом разговоре: в новом
 * звонке бригада на месте не говорит «едем, по прибытии доложу» (проверка связности 17.10).
 */
export function lastPlainReport(
  presented: readonly InformationEvidence[],
  brigadeId: string,
): string | null {
  const plain = presented.filter(
    (item) =>
      item.delivery.brigade_id === brigadeId &&
      !item.delivery.reply_options?.length &&
      item.delivery.answer !== true,
  );
  const last = plain.length ? plain[plain.length - 1] : null;
  // Доклад о выезде не повторяют: «выезжаем» в пути противоречит сказанному — до следующего
  // доклада бригада обещает доложить по прибытии.
  return last && last.delivery.departure !== true
    ? last.delivery.message.text
    : null;
}

/** Система-112: через неё вызывают любую службу (номер ожидания у каждой просьбы о службе). */
export const SYSTEM_112 = "112";
/**
 * Сколько окно верит своему набору номера службы, пока выдача его не принесла: обучение
 * опрашивается раз в 2 с, и вернувшись с удержания через секунду после набора, диспетчер
 * иначе услышал бы «Принял», хотя сервер весть засчитает. Дальше верна только выдача.
 */
export const LOCAL_DIAL_TRUST_MS = 10_000;

/**
 * Набор номера службы: из выдачи (`CardTraining.service_calls`) или свой звонок окна
 * (`local`, ещё не дошёл до выдачи). `at` — время сервера, мс.
 */
export interface ServiceDial {
  readonly service: string;
  readonly at: number;
  readonly local?: boolean;
}

/** Звонки в службы из выдачи — во времени сервера. */
export function serverDials(
  calls: readonly {
    readonly service_id: string;
    readonly started_at: string;
  }[] = [],
): ServiceDial[] {
  return calls.map((call) => ({
    service: call.service_id,
    at: Date.parse(call.started_at),
  }));
}

/** Первый набор номера службы `service` (или 112) с `since` по `now`; `null` — не набирали. */
function dialedAt(
  dials: readonly ServiceDial[],
  service: string,
  since: number,
  now: number,
): number | null {
  const found = dials
    .filter(
      (dial) =>
        (dial.service === service || dial.service === SYSTEM_112) &&
        dial.at >= since &&
        dial.at <= now &&
        (!dial.local || now - dial.at <= LOCAL_DIAL_TRUST_MS),
    )
    .map((dial) => dial.at);
  return found.length ? Math.min(...found) : null;
}

/**
 * Просьбы бригады о службах (`delivery.needs_service`, HQ-055) и засчитал бы сервер сейчас
 * весть о них: по просьбе позвонили в службу (`service_called_at`; служба вызвана заранее —
 * звонок до просьбы, GP-28) и срок сообщить не прошёл (`news_by`; нет — звонок в службу ещё
 * идёт). Окно то же, что у сервера (`evalcore.brigade.news_window`, `ahead_window`): до
 * звонка «скорая будет» — неправда, после приезда — поздно, бригада отвечает на такую фразу
 * обычно. Пока выдача не принесла звонок, окно открывает свой набор номера службы после
 * просьбы (`ServiceDial.local`). `service` — о какой службе «отправил» без названия:
 * последняя просьба в окне, иначе последняя просьба (`null` — бригада не просила); `open` —
 * есть просьба в окне; `asked` — все просимые службы, `opened` — те, что в окне; `called` —
 * службы, номер которых уже набран (весть о службе, которую не просили, — только после
 * набора, GP-28; 112 — любая служба).
 *
 * `now` — время сервера (`serverNow`): поля выдачи — его часы, а часы компьютера в классе
 * могут уйти на десятки секунд при окне вести в 20 с.
 */
export interface AwaitedService {
  readonly service: string | null;
  readonly open: boolean;
  readonly asked: readonly string[];
  readonly opened: readonly string[];
  readonly called: readonly string[];
}

export function awaitedService(
  presented: readonly InformationEvidence[],
  brigadeId: string,
  now: number,
  dials: readonly ServiceDial[] = [],
): AwaitedService {
  const local = dials.filter((dial) => dial.local);
  const asks = presented.flatMap((item) => {
    const delivery = item.delivery;
    if (delivery.brigade_id !== brigadeId || !delivery.needs_service) return [];
    const called = delivery.service_called_at
      ? Date.parse(delivery.service_called_at)
      : dialedAt(
          local,
          delivery.needs_service,
          delivery.delivered_at ? Date.parse(delivery.delivered_at) : now,
          now,
        );
    const by = delivery.news_by ? Date.parse(delivery.news_by) : null;
    const open = called !== null && now >= called && (by === null || now <= by);
    return [{ service: delivery.needs_service, open }];
  });
  const opened = asks.filter((ask) => ask.open);
  const about = opened.length ? opened : asks;
  return {
    service: about.length ? about[about.length - 1].service : null,
    open: opened.length > 0,
    asked: asks.map((ask) => ask.service),
    opened: opened.map((ask) => ask.service),
    called: [
      ...new Set(
        dials
          .filter(
            (dial) => dialedAt([dial], dial.service, dial.at, now) !== null,
          )
          .map((dial) => dial.service),
      ),
    ],
  };
}

/** Предъявленные сведения — по ним обучаемый пишет комментарий в карточку. */
export function presentedMessages(
  messages: readonly InformationEvidence[],
): InformationEvidence[] {
  return messages
    .filter((item) => item.state === "presented")
    .sort((left, right) => byTime(left.presented_at, right.presented_at));
}
