import { describe, expect, it } from "vitest";
import type { Card } from "../shared/api";
import {
  availableStatuses,
  withConfirmedState,
  canRedirect,
  closesCard,
  commentHint,
  confirmAgainText,
  commentOnStatusChange,
  formatAddress,
  formatDuration,
  formatOkrug,
  fullAddress,
  fullDateTime,
  clockDate,
  clockParts,
  handlingTimer,
  isClosed,
  latePrimaryId,
  newestFirst,
  okrugName,
  previewRows,
  reactionTimer,
  REASON_REQUIRED,
  shortDate,
  STATE_LABELS,
  statusFormKey,
  timerLabel,
  visibleHistory,
} from "./cardModel";
import { findParticipant } from "./useParticipant";
import { otherServiceStatus } from "./otherServices";

const base: Card = {
  id: "00000000-0000-4000-8000-000000000200",
  assignment_id: "00000000-0000-4000-8000-000000000300",
  trainee_id: "00000000-0000-4000-8000-000000000001",
  session_id: "00000000-0000-4000-8000-000000000400",
  state: "added",
  appeared_at: "2026-09-19T09:00:00Z",
  delivered_at: null,
  opened_at: null,
  closed_at: null,
  interrupted_at: null,
  source: {
    number: "10000001",
    incident_type_code: "2020000",
    caller_name: "Учебный заявитель",
    phone_aon: "+79000000001",
    phone_provided: "",
    phone_scene: "",
    address: {
      city: "Москва",
      okrug: "Северный",
      district: "Учебный",
      street: "Дубнинская улица",
      house: "1",
      building: "",
      apartment: "",
    },
    description: "Учебный сценарий",
    tags: ["ДТП"],
    victims: true,
    ambulance_refused: false,
    blocked_people: false,
    emergency: false,
    incident_class: "ДТП с пострадавшими",
    service_ids: ["102", "103"],
  },
  current: { service_number: "", comment: "" },
};

const appeared = Date.parse(base.appeared_at);

describe("жизненный цикл карточки", () => {
  it("из новой карточки доступны только Принята и Не принята", () => {
    expect(availableStatuses("added")).toEqual(["accepted", "rejected"]);
    expect(availableStatuses("received")).toEqual(["accepted", "rejected"]);
  });

  it("этапы v3 идут вперёд, пропуск допустим (CARD_TRANSITIONS)", () => {
    expect(availableStatuses("accepted")).toEqual([
      "responding",
      "arrived",
      "working",
      "completed",
      "refused",
    ]);
    expect(availableStatuses("responding")).toEqual([
      "arrived",
      "working",
      "completed",
      "refused",
    ]);
    expect(availableStatuses("arrived")).toEqual([
      "working",
      "completed",
      "refused",
    ]);
    expect(availableStatuses("working")).toEqual(["completed", "refused"]);
  });

  it("после «Не принята» можно поставить «Принята» (памятка, стр. 32)", () => {
    expect(availableStatuses("rejected")).toEqual(["accepted"]);
  });

  it("отказные статусы требуют причины, завершающие закрывают карточку", () => {
    expect([...REASON_REQUIRED].sort()).toEqual(["refused", "rejected"]);
    expect(closesCard("completed")).toBe(true);
    expect(closesCard("refused")).toBe(true);
    expect(closesCard("working")).toBe(false);
  });

  it("второе нажатие ✓ подписано: что именно оно сделает", () => {
    expect(confirmAgainText("completed")).toBe(
      "Нажмите ✓ или Enter ещё раз — карточка закроется",
    );
    expect(confirmAgainText("refused")).toMatch(/карточка закроется$/);
    // «Не принята» карточку не закрывает: дальше перенаправление.
    expect(confirmAgainText("rejected")).toBe(
      "Нажмите ✓ или Enter ещё раз — статус «Не принята» сохранится",
    );
  });

  it("в закрытых состояниях действий не остаётся", () => {
    for (const state of ["completed", "refused", "redirected"] as const) {
      expect(availableStatuses(state)).toEqual([]);
      expect(isClosed({ state })).toBe(true);
    }
  });

  it("перенаправление доступно только после «Не принята»", () => {
    expect(canRedirect("rejected")).toBe(true);
    expect(canRedirect("accepted")).toBe(false);
  });
});

describe("таймер реакции (норматив 30 с)", () => {
  // Строка появилась на АРМ сразу после выдачи.
  const shown: Card = { ...base, delivered_at: base.appeared_at };

  it("идёт, пока карточку не открыли", () => {
    const timer = reactionTimer(shown, 30, appeared + 12_000);
    expect(timer).toEqual({ seconds: 12, overdue: false, stopped: false });
  });

  it("краснеет после превышения норматива", () => {
    expect(reactionTimer(shown, 30, appeared + 31_000).overdue).toBe(true);
    expect(reactionTimer(shown, 30, appeared + 30_000).overdue).toBe(false);
  });

  it("останавливается на моменте открытия, а не на текущем времени", () => {
    const opened: Card = { ...shown, opened_at: "2026-09-19T09:00:20Z" };
    const timer = reactionTimer(opened, 30, appeared + 600_000);
    expect(timer).toEqual({ seconds: 20, overdue: false, stopped: true });
  });

  it("не идёт, пока строку не показали на АРМ", () => {
    expect(reactionTimer(base, 30, appeared + 600_000)).toEqual({
      seconds: 0,
      overdue: false,
      stopped: true,
    });
  });

  it("считает с показа, а не с выдачи: опоздавший вход не штрафуется", () => {
    const late: Card = { ...base, delivered_at: "2026-09-19T09:10:00Z" };
    const timer = reactionTimer(late, 30, appeared + 605_000);
    expect(timer).toEqual({ seconds: 5, overdue: false, stopped: false });
  });

  it("замирает на прерывании — завершённое занятие не тикает до 99:59+", () => {
    const stopped: Card = {
      ...shown,
      interrupted_at: "2026-09-19T09:00:40Z",
    };
    const timer = reactionTimer(stopped, 30, appeared + 86_400_000);
    expect(timer).toEqual({ seconds: 40, overdue: true, stopped: true });
  });
});

describe("таймер отработки (норматив 3 мин)", () => {
  it("не начат, пока карточка не открыта", () => {
    expect(handlingTimer(base, 180, appeared + 60_000).seconds).toBe(0);
  });

  it("считает от открытия и краснеет после 3 минут", () => {
    const opened: Card = { ...base, opened_at: "2026-09-19T09:00:10Z" };
    const started = Date.parse(opened.opened_at!);
    expect(handlingTimer(opened, 180, started + 181_000).overdue).toBe(true);
    expect(handlingTimer(opened, 180, started + 100_000)).toEqual({
      seconds: 100,
      overdue: false,
      stopped: false,
    });
  });

  it("останавливается на прерывании попытки", () => {
    const stopped: Card = {
      ...base,
      opened_at: "2026-09-19T09:00:10Z",
      interrupted_at: "2026-09-19T09:00:40Z",
    };
    expect(handlingTimer(stopped, 180, appeared + 86_400_000)).toEqual({
      seconds: 30,
      overdue: false,
      stopped: true,
    });
  });

  it("останавливается на закрытии карточки", () => {
    const closed: Card = {
      ...base,
      opened_at: "2026-09-19T09:00:10Z",
      closed_at: "2026-09-19T09:01:10Z",
      state: "completed",
    };
    expect(handlingTimer(closed, 180, Date.now())).toEqual({
      seconds: 60,
      overdue: false,
      stopped: true,
    });
  });
});

describe("подписи полей", () => {
  it("адрес собирается из улицы, дома и квартиры", () => {
    expect(formatAddress(base.source.address)).toBe("Дубнинская улица, 1");
    expect(
      formatAddress({ ...base.source.address, building: "2", apartment: "15" }),
    ).toBe("Дубнинская улица, 1 к2, кв. 15");
  });

  it("данные оператора о доступе и ориентире доходят до адреса ДДС", () => {
    expect(
      formatAddress({
        ...base.source.address,
        object: "жилой дом",
        structure: "3",
        entrance: "2",
        floor: "5",
        code: "123",
        descriptive: "Напротив школы",
      }),
    ).toBe(
      "Дубнинская улица, 1, жилой дом, стр. 3, подъезд 2, этаж 5, код 123, Напротив школы",
    );
  });

  it("округ и район показываются в скобках, как в шапке карточки", () => {
    expect(formatOkrug(base.source.address)).toBe(
      "Москва, (Северный, Учебный)",
    );
    expect(
      formatOkrug({ ...base.source.address, okrug: "", district: "" }),
    ).toBe("Москва");
  });

  it("адрес одной строкой и полное название округа — как в arm_dds/06", () => {
    expect(fullAddress(base.source.address)).toBe(
      "Москва, (Северный, Учебный), Дубнинская улица, 1",
    );
    expect(okrugName(base.source.address)).toBe("");
    expect(okrugName({ ...base.source.address, okrug: "ТАО" })).toBe(
      "Троицкий административный округ",
    );
  });

  it("дата и часы — в записи АРМ, месяц в именительном падеже", () => {
    const moment = new Date(2026, 8, 17, 11, 3, 8);
    expect(shortDate(moment)).toBe("17.09.26");
    expect(fullDateTime(moment)).toBe("17.09.2026 11:03:08");
    expect(clockDate(moment)).toBe("Четверг, 17 Сентябрь 2026");
    expect(clockParts(moment)).toEqual({ hm: "11:03", s: "08" });
  });

  it("длительность выводится как мм:сс", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(95)).toBe("01:35");
    expect(formatDuration(3600)).toBe("60:00");
    expect(formatDuration(5999)).toBe("99:59");
    expect(formatDuration(257_503)).toBe("99:59+");
  });
});

describe("порядок реестра", () => {
  it("новые происшествия сверху, старые снизу; при равном времени — по id", () => {
    const at = (id: string, appeared_at: string) => ({ id, appeared_at });
    const cards = [
      at("a", "2026-09-28T09:00:00Z"),
      at("c", "2026-09-28T09:05:00Z"),
      at("b", "2026-09-28T09:05:00Z"),
      at("d", "2026-09-28T08:59:59Z"),
    ];
    expect(newestFirst(cards).map((card) => card.id)).toEqual([
      "c",
      "b",
      "a",
      "d",
    ]);
    // Порядок сервера не меняется: кэш запроса общий с вкладками и разбором.
    expect(cards.map((card) => card.id)).toEqual(["a", "c", "b", "d"]);
  });
});

describe("контекст занятия", () => {
  const session = {
    participants: [
      { user_id: "u1", workstation_number: 1, dds_service_id: "102", level: 1 },
      { user_id: "u2", workstation_number: 7, dds_service_id: "101", level: 2 },
    ],
  };

  it("служба берётся из участия, а не из профиля", () => {
    expect(findParticipant(session, "u2")?.dds_service_id).toBe("101");
    expect(findParticipant(session, "u2")?.workstation_number).toBe(7);
  });

  it("обучаемого нет в составе занятия — участия нет", () => {
    expect(findParticipant(session, "u3")).toBeNull();
  });

  it("занятие ещё не загружено — участия нет", () => {
    expect(findParticipant(undefined, "u1")).toBeNull();
  });
});

describe("форма статуса с клавиатуры", () => {
  it("Enter в поле отправляет, Shift+Enter — нет, Esc отменяет", () => {
    expect(statusFormKey("Enter", false, true)).toBe("submit");
    expect(statusFormKey("Enter", true, true)).toBeNull();
    expect(statusFormKey("Escape", false, true)).toBe("cancel");
    expect(statusFormKey("Escape", false, false)).toBe("cancel");
    // На списке статусов и кнопках Enter остаётся штатным.
    expect(statusFormKey("Enter", false, false)).toBeNull();
    expect(statusFormKey("a", false, true)).toBeNull();
  });
});

describe("комментарий при смене статуса", () => {
  it("прошлый комментарий карточки очищается под подсказку", () => {
    expect(
      commentOnStatusChange("принято, выслан", "принято, выслан", undefined),
    ).toBe("");
  });
  it("хвостовой пробел не мешает узнать отправленный комментарий", () => {
    expect(commentOnStatusChange("принято ", "принято", undefined)).toBe("");
  });
  it("черновик пары карточка+статус возвращается", () => {
    expect(
      commentOnStatusChange("принято, выслан", "принято, выслан", "прибыли"),
    ).toBe("прибыли");
    expect(commentOnStatusChange("своё", "принято", "")).toBe("");
  });
  it("введённое вручную не затирается", () => {
    expect(
      commentOnStatusChange("сведения уточнены", "принято", undefined),
    ).toBe("сведения уточнены");
    expect(commentOnStatusChange("", "", undefined)).toBe("");
  });
});

describe("подпись таймера шапки", () => {
  it("до первичного статуса — реакция, после — обработка", () => {
    expect(timerLabel("added")).toBe("реакция");
    expect(timerLabel("received")).toBe("реакция");
    expect(timerLabel("accepted")).toBe("обработка");
    expect(timerLabel("rejected")).toBe("обработка");
    expect(timerLabel("completed")).toBe("обработка");
  });
});

describe("история статусов", () => {
  const events = [
    { id: "1", type: "deliver" },
    { id: "2", type: "card_open" },
    { id: "3", type: "open" },
    { id: "4", type: "call_dial" },
    { id: "5", type: "field_change" },
    { id: "6", type: "status_change" },
    { id: "7", type: "hint_open" },
    { id: "8", type: "redirect" },
  ];
  it("по умолчанию — только статусы, перенаправление и правки полей", () => {
    expect(visibleHistory(events, false).map((event) => event.id)).toEqual([
      "5",
      "6",
      "8",
    ]);
  });
  it("«все действия» возвращает журнал целиком и в прежнем порядке", () => {
    expect(visibleHistory(events, true)).toEqual(events);
    expect(visibleHistory(events, true)).not.toBe(events);
  });
});

describe("рабочее поле по памятке ДДС (GP-16)", () => {
  it("служба 103 не ставит «Не принята» и «Отказ от выполнения работ» (с. 23)", () => {
    expect(availableStatuses("received", "103")).toEqual(["accepted"]);
    expect(availableStatuses("accepted", "103")).toEqual([
      "responding",
      "arrived",
      "working",
      "completed",
    ]);
    expect(availableStatuses("received", "102")).toEqual([
      "accepted",
      "rejected",
    ]);
    expect(commentHint("completed", "103")).toContain(
      "Завершение работ без бригады",
    );
    expect(commentHint("completed", "102")).not.toContain("без бригады");
  });

  const status = (id: string, state: string, at: number) => ({
    id,
    type: "status_change",
    server_ts: new Date(at).toISOString(),
    payload: { state },
  });

  it("первичный статус позже 30 с — время красным (с. 21, 25)", () => {
    const shown = { ...base, delivered_at: base.appeared_at };
    expect(
      latePrimaryId(shown, [status("a", "accepted", appeared + 29_000)]),
    ).toBeNull();
    expect(
      latePrimaryId(shown, [status("a", "accepted", appeared + 31_000)]),
    ).toBe("a");
    // «Принята» после ошибочной «Не принята» — исправление, не опоздание (с. 32).
    expect(
      latePrimaryId(shown, [
        status("r", "rejected", appeared + 10_000),
        status("a", "accepted", appeared + 90_000),
      ]),
    ).toBeNull();
    // Срок — от показа карточки службе.
    expect(
      latePrimaryId(
        { ...base, delivered_at: new Date(appeared + 60_000).toISOString() },
        [status("a", "accepted", appeared + 80_000)],
      ),
    ).toBeNull();
    expect(latePrimaryId(shown, [])).toBeNull();
  });

  it("предпросмотр строки: службы со статусами, заявитель, признаки (с. 13)", () => {
    const services = [
      { id: "102", name: "Служба 102" },
      { id: "103", name: "Служба 103" },
    ];
    const at = new Date(appeared + 75_000);
    const hms = (moment: Date) =>
      `${clockParts(moment).hm}:${clockParts(moment).s}`;
    const rows = previewRows(
      { ...base, state: "accepted" },
      services,
      "102",
      at.toISOString(),
    );
    expect(rows).toEqual([
      {
        label: "Службы:",
        text: `Служба 102 — ${hms(at)} Принята, Служба 103 — ${hms(new Date(appeared))} Добавлена`,
      },
      { label: "Заявитель:", text: "Учебный заявитель   АОН +79000000001" },
      { label: "Информация:", text: "ДТП." },
    ]);
  });

  it("предпросмотр: чужая служба — по расписанию мира (TC-07)", () => {
    const services = [
      { id: "102", name: "Служба 102" },
      { id: "103", name: "Служба 103" },
    ];
    const now = appeared + 120_000;
    const step = otherServiceStatus(
      "card-1",
      "103",
      new Date(appeared).toISOString(),
      now,
    );
    const moment = new Date(step.atMs);
    const [notified] = previewRows(
      { ...base, id: "card-1", state: "accepted" },
      services,
      "102",
      new Date(appeared + 75_000).toISOString(),
      now,
    );
    expect(step.state).not.toBe("added");
    expect(notified.text).toContain(
      `Служба 103 — ${clockParts(moment).hm}:${clockParts(moment).s} ${STATE_LABELS[step.state]}`,
    );
  });
});

describe("withConfirmedState", () => {
  const cards = [
    { id: "a", state: "received" as const, number: 1 },
    { id: "b", state: "received" as const, number: 2 },
  ];

  it("принятый сервером статус сразу в списке, у других карточек — без изменений", () => {
    const next = withConfirmedState(cards, "a", "accepted");
    expect(next).toEqual([
      { id: "a", state: "accepted", number: 1 },
      { id: "b", state: "received", number: 2 },
    ]);
    expect(next?.[1]).toBe(cards[1]);
  });

  it("списка ещё нет — нечего обновлять", () => {
    expect(withConfirmedState(undefined, "a", "accepted")).toBeUndefined();
  });
});
