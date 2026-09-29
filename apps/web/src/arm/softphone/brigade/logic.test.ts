import { describe, expect, it } from "vitest";
import type { components } from "../../../api-client/schema";
import {
  awaitsDecision,
  directBlock,
  forcesBoard,
  pendingMessages,
  planDial,
  presentedMessages,
  refusalNote,
  stateLabel,
} from "./logic";

type Service = components["schemas"]["Service"];
type CallTarget = components["schemas"]["CallTarget"];
type InformationEvidence = components["schemas"]["InformationEvidence"];

const police: Service = {
  id: "102",
  code: "102",
  name: "Полиция",
  category: "МВД",
  phone_ext: "102",
  voice_profile: "voice-2",
  is_active: true,
};

const brigadeA = "00000000-0000-4000-8000-00000000000a";
const brigadeB = "00000000-0000-4000-8000-00000000000b";

function target(
  id: string,
  phoneExt: string,
  brigadeId: string | null,
  isActive = true,
): CallTarget {
  return {
    id,
    service_id: "102",
    brigade_id: brigadeId,
    name: brigadeId ? "Старший бригады" : "Диспетчер службы",
    phone_ext: phoneExt,
    voice_profile: "voice-2",
    is_active: isActive,
  };
}

const targets = [
  target("t-dispatcher", "102", null),
  target("t-a", "203", brigadeA),
  target("t-b", "204", brigadeB),
  target("t-off", "205", brigadeA, false),
];

describe("набор номера", () => {
  it("прямой номер направленной бригады — звонок адресату", () => {
    const plan = planDial("203", [police], targets, [brigadeA]);
    expect(plan).toEqual({ kind: "target", target: targets[1] });
  });

  it("бригада не направлена — звонок проходит, она ответит отказом", () => {
    expect(planDial("204", [police], targets, [brigadeA])).toEqual({
      kind: "refused",
      target: targets[2],
      reason: "not_assigned",
      busyOn: null,
    });
  });

  it("занятая на другом происшествии бригада отвечает, что занята", () => {
    const busy = new Map([[brigadeB, "7"]]);
    expect(planDial("204", [police], targets, [brigadeA], busy)).toEqual({
      kind: "refused",
      target: targets[2],
      reason: "busy",
      busyOn: "7",
    });
  });

  it("номер общего диспетчера — обычный звонок в службу", () => {
    expect(planDial("102", [police], targets, [brigadeA])).toEqual({
      kind: "service",
      service: police,
    });
  });

  it("неизвестный номер не уходит на сервер", () => {
    expect(planDial("999", [police], targets, [brigadeA]).kind).toBe("unknown");
  });

  it("неактивный адресат и неактивная служба не обслуживаются", () => {
    expect(planDial("205", [police], targets, [brigadeA]).kind).toBe("unknown");
    expect(
      planDial("102", [{ ...police, is_active: false }], [], []).kind,
    ).toBe("unknown");
  });
});

function evidence(
  id: string,
  state: InformationEvidence["state"],
  deliveredAt: string,
  presentedAt: string | null = null,
): InformationEvidence {
  return {
    delivery: {
      delivery_id: id,
      card_id: "card",
      call_id: "call",
      participant_id: "trainee",
      brigade_id: brigadeA,
      call_target_id: "t-a",
      message: { id: `m-${id}`, version: 1, text: id, audio: null },
      delivered_at: deliveredAt,
    },
    state,
    presented_at: presentedAt,
    failed_at: state === "failed" ? deliveredAt : null,
    presentation_event_id: presentedAt ? `e-${id}` : null,
    failure_reason: state === "failed" ? "playback_error" : null,
  };
}

describe("выданные сведения", () => {
  const messages = [
    evidence("third", "delivered", "2026-09-25T10:00:30Z"),
    evidence(
      "first",
      "presented",
      "2026-09-25T10:00:00Z",
      "2026-09-25T10:00:05Z",
    ),
    evidence("second", "failed", "2026-09-25T10:00:10Z"),
  ];

  it("непредъявленные — по времени выдачи, сбой тоже ждёт повтора", () => {
    expect(
      pendingMessages(messages).map((m) => m.delivery.delivery_id),
    ).toEqual(["second", "third"]);
  });

  it("предъявленные остаются на виду в порядке предъявления", () => {
    expect(
      presentedMessages(messages).map((m) => m.delivery.delivery_id),
    ).toEqual(["first"]);
  });
});

describe("табло сил", () => {
  const brigades = [
    { id: brigadeA, service_id: "102", name: "Бригада 1", is_active: true },
    { id: brigadeB, service_id: "102", name: "Бригада 2", is_active: true },
    {
      id: "00000000-0000-4000-8000-00000000000c",
      service_id: "102",
      name: "Бригада 3",
      is_active: true,
    },
  ];

  it("у каждой бригады номер и состояние словами", () => {
    const board = forcesBoard(
      brigades,
      targets,
      [brigadeA],
      new Map([[brigadeB, "7"]]),
    );
    expect(board.map((row) => [row.name, row.ext, stateLabel(row)])).toEqual([
      ["Бригада 1", "203", "направлена сюда"],
      ["Бригада 2", "204", "занята: происшествие 7"],
      ["Бригада 3", null, "свободна"],
    ]);
  });
});

describe("направление бригады после решения", () => {
  it("до «Принята» и после «Не принята» направить нельзя — видно почему", () => {
    expect(directBlock("received")).toContain("«Принята»");
    expect(directBlock("added")).toContain("«Принята»");
    expect(directBlock("rejected")).toContain("не принята");
    expect(directBlock("completed")).toContain("закрыта");
  });

  it("совет «поставьте «Принята»» — только пока решения нет", () => {
    expect(awaitsDecision("received")).toBe(true);
    expect(awaitsDecision("rejected")).toBe(true);
    expect(awaitsDecision("accepted")).toBe(false);
    expect(awaitsDecision("completed")).toBe(false);
    expect(awaitsDecision(null)).toBe(false);
  });

  it("после «Принята» и на этапах реагирования — можно", () => {
    for (const state of [
      "accepted",
      "responding",
      "arrived",
      "working",
    ] as const)
      expect(directBlock(state)).toBeNull();
    expect(directBlock(null)).toBeNull();
  });

  it("после отказа объясняет, что делать, с учётом решения по карточке", () => {
    const free = { reason: "not_assigned", busyOn: null } as const;
    expect(refusalNote(free, true)).toContain("«Направить выбранные»");
    expect(refusalNote(free, false)).toContain("«Принята»");
    expect(refusalNote({ reason: "busy", busyOn: "7" }, true)).toContain(
      "происшествии 7",
    );
    // Бригады нет в списке панели — отметить её нельзя, совет другой.
    expect(refusalNote(free, true, false)).toContain("не в вашем распоряжении");
  });
});
