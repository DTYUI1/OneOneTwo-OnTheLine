import { describe, expect, it } from "vitest";
import type { Card } from "../shared/api";
import {
  availableStatuses,
  canRedirect,
  closesCard,
  commentOnStatusChange,
  formatAddress,
  formatDuration,
  formatOkrug,
  handlingTimer,
  isClosed,
  newestFirst,
  reactionTimer,
  REASON_REQUIRED,
  statusFormKey,
  timerLabel,
  visibleHistory,
} from "./cardModel";
import { findParticipant } from "./useParticipant";

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

  it("округ и район показываются в скобках, как в шапке карточки", () => {
    expect(formatOkrug(base.source.address)).toBe(
      "Москва, (Северный, Учебный)",
    );
    expect(
      formatOkrug({ ...base.source.address, okrug: "", district: "" }),
    ).toBe("Москва");
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
