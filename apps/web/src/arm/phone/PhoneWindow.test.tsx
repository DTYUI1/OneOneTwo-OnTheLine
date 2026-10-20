import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useEffect } from "react";
import type { Card, ServerEvent } from "../../shared/api";
import type { components } from "../../api-client/schema";
import {
  PhoneContext,
  ContactList,
  PhoneDial,
  PhoneWindow,
  usePhoneLines,
  usePhoneState,
  type ControlLine,
  type MissedRing,
  type Ring,
} from "./PhoneWindow";
import { initialHold } from "./hold";
import { forcesBoard } from "../softphone/brigade/logic";
import { brigadeWho } from "./lines";
import { brigadeCallSignal, alarmCallSignal } from "../signals";
import { readFileSync } from "node:fs";

const phoneCss = readFileSync(
  new URL("./Phone.module.css", import.meta.url),
  "utf8",
);

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  invalidateQueries: vi.fn(),
  queries: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  // SSR даёт проверить разметку без DOM; эффекты запускаем отдельно, как после commit.
  useEffect: vi.fn(),
  useLayoutEffect: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [] }),
  useQueries: (options: unknown) => mocks.queries(options),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));
vi.mock("../../shared/session", () => ({
  useSession: () => ({ realtime: { subscribe: mocks.subscribe } }),
}));
vi.mock("../signals", () => ({
  brigadeCallSignal: vi.fn(),
  alarmCallSignal: vi.fn(),
  stopCallSignal: vi.fn(),
}));
vi.mock("../../shared/help/HelpProvider", () => ({
  useHelpState: () => ({ openTopic: vi.fn() }),
}));
vi.mock("../useNow", () => ({ useNow: () => 30_000 }));
vi.mock("./useLearned", () => ({
  useLearned: () => ({ done: vi.fn(), shown: () => false }),
}));
vi.mock("../../shared/useFloatingWindow", () => ({
  useFloatingWindow: () => ({
    collapsed: false,
    toggleCollapsed: vi.fn(),
    redock: vi.fn(),
    edgeProps: () => ({}),
    style: {},
    headerProps: {},
    resizeProps: {},
  }),
}));

it("в силах службы имя, номер набора и линия обозначают одну бригаду; группы прежние", () => {
  const numbers = ["201", "202", "301", "302"];
  const brigades = numbers.map((ext) => ({
    id: `brigade-${ext}`,
    service_id: "101",
    name: `Бригада ${ext}`,
    is_active: true,
  }));
  // API теперь сортирует старших раньше диспетчера: табло связывает их по UUID.
  const targets = [
    ...numbers.map((ext) => ({
      id: `target-${ext}`,
      service_id: "101",
      brigade_id: `brigade-${ext}`,
      name: `Старший бригады ${ext}`,
      phone_ext: ext,
      voice_profile: "voice-1",
      is_active: true,
    })),
    {
      id: "dispatcher",
      service_id: "101",
      brigade_id: null,
      name: "Учебный диспетчер 101",
      phone_ext: "101",
      voice_profile: "voice-1",
      is_active: true,
    },
  ];
  const board = forcesBoard(brigades, targets, [], new Map());
  const html = renderToStaticMarkup(
    <ContactList
      brigades={board.map((row) => ({ ...row, stateText: "свободна" }))}
      persons={[
        { role: "head", name: "Руководитель", number: "901" },
        { role: "caller", name: "Заявитель", number: "903" },
      ]}
      services={[
        {
          id: "102",
          code: "102",
          name: "Служба 102",
          category: "police",
          phone_ext: "102",
          voice_profile: "voice-2",
          is_active: true,
        },
      ]}
      ownExt="101"
      onDial={() => undefined}
    />,
  );
  const rows = [
    ...html.matchAll(
      /<button[^>]*data-state="free"[^>]*data-ext="(\d+)"[^>]*>.*?<b>(.*?)<\/b>/g,
    ),
  ];
  expect(rows.map((row) => row[1])).toEqual(numbers);
  for (const [, ext, name] of rows) {
    expect(name).toBe(`Бригада ${ext}`);
    expect(brigadeWho(ext)).toBe(`Старший бригады · ${ext}`);
  }
  const groups = [
    "Силы службы",
    "Руководство и аварийная бригада",
    "Службы",
    "По карточке — добавил преподаватель",
  ].map((name) => html.indexOf(`>${name}</li>`));
  expect(groups.every((position) => position >= 0)).toBe(true);
  expect(groups).toEqual([...groups].sort((left, right) => left - right));
});

const card = {
  id: "card-1",
  source: { number: "70005101" },
} as Card;
const ring: Ring = {
  card,
  callId: "brigade",
  name: "Бригада",
  ext: "201",
  alarm: false,
  startedAt: 0,
};
const control: ControlLine = {
  card,
  control: {
    call_id: "control",
    started_at: "2026-10-18T14:28:31Z",
    answered_at: null,
    ended_at: null,
    end_reason: null,
    without_status_s: 60,
    reply_options: [],
    reply: null,
  },
};
const missed: MissedRing = {
  ...ring,
  endedAt: 25_000,
  lost: false,
};

function Phone({
  open = false,
  rings = [],
  controls = [],
  missed = [],
  final = false,
  away = false,
}: {
  open?: boolean;
  rings?: readonly Ring[];
  controls?: readonly ControlLine[];
  missed?: readonly MissedRing[];
  final?: boolean;
  away?: boolean;
}) {
  const phone = usePhoneState(rings, missed, initialHold, controls);
  return (
    <PhoneContext.Provider value={{ ...phone, open }}>
      <PhoneDial />
      <PhoneWindow
        title="Телефон"
        own="+7 (495) 000-00-01"
        away={away}
        onAnswer={vi.fn()}
        brigadeOnly={final ? new Set([card.id]) : undefined}
        idle={<span>Контакты</span>}
      />
    </PhoneContext.Provider>
  );
}

beforeEach(() => vi.clearAllMocks());

describe("номер рабочего места в шапке телефона", () => {
  it("не предлагает кнопку объяснения телефона", () => {
    const html = renderToStaticMarkup(<Phone open />);
    expect(html).not.toContain('aria-label="Объяснение телефона"');
    expect(html).toContain("Закрыть");
  });

  it("сохраняет полный номер: шапка переносится, номер не сжимается и не обрезается", () => {
    expect(renderToStaticMarkup(<Phone open />)).toContain(
      "+7 (495) 000-00-01",
    );
    // SSR не считает геометрию: защищаем причину регрессии; ширины проверяет Playwright.
    const ownRule = phoneCss.match(/\.own\s*\{([^}]*)\}/)?.[1];
    const headRule = phoneCss.match(/\.talkHead\s*\{([^}]*)\}/)?.[1];
    expect(ownRule).toMatch(/flex:\s*(?:none|0\s+0\s+auto)\s*;/);
    expect(ownRule).not.toMatch(/overflow:\s*hidden/);
    expect(headRule).toMatch(/flex-wrap:\s*wrap\s*;/);
  });
});

describe("входящий виден и слышен независимо от окна телефона", () => {
  it.each([false, true])(
    "окно открыто: %s — отдел контроля и бригада",
    (open) => {
      const html = renderToStaticMarkup(
        <Phone open={open} rings={[ring]} controls={[control]} />,
      );
      expect(html).toContain('data-ring="true"');
      expect(html).toContain('aria-label="Телефон: входящих 2"');
      expect(html).toContain('data-line="ringing"');
      expect(html).toContain("Старший бригады · 201");
      expect(html).toContain("Отдел контроля");
      expect(html.includes('hidden=""')).toBe(!open);
      // Первый эффект — общий сигнал АРМ; окно и вкладки не имеют своего рингтона.
      vi.mocked(useEffect).mock.calls[0][0]();
      expect(brigadeCallSignal).toHaveBeenCalledTimes(1);
      expect(alarmCallSignal).not.toHaveBeenCalled();
    },
  );

  it.each(["control", "brigade", "alarm"])("закрытое окно: %s", (kind) => {
    const html = renderToStaticMarkup(
      <Phone
        controls={kind === "control" ? [control] : []}
        rings={kind === "control" ? [] : [{ ...ring, alarm: kind === "alarm" }]}
      />,
    );
    expect(html).toContain('aria-label="Телефон: входящих 1"');
    expect(html).toContain('data-ring="true"');
    expect(html).toContain(`data-alarm="${kind === "alarm"}"`);
    vi.mocked(useEffect).mock.calls[0][0]();
    expect(
      kind === "alarm" ? alarmCallSignal : brigadeCallSignal,
    ).toHaveBeenCalledTimes(1);
  });

  it("после окончания вызовов остаются счётчик и обе строки пропущенных", () => {
    const html = renderToStaticMarkup(
      <Phone
        missed={[missed]}
        controls={[
          {
            ...control,
            control: {
              ...control.control,
              ended_at: "2026-10-18T14:28:56Z",
              end_reason: "missed",
            },
          },
        ]}
      />,
    );
    expect(html).toContain('data-ring="false"');
    expect(html).toContain('data-missed="true"');
    expect(html).toContain('aria-label="Телефон: пропущенных 2"');
    expect(html.match(/data-line="missed"/g)).toHaveLength(2);
    expect(html).toContain("Перезвонить");
    expect(html).toContain("Отдел контроля");
    vi.mocked(useEffect).mock.calls[0][0]();
    expect(brigadeCallSignal).not.toHaveBeenCalled();
  });

  it("список (карточка не открыта): открытое окно скрыто, в карточке — снова видно", () => {
    const html = (away: boolean) =>
      renderToStaticMarkup(<Phone open rings={[ring]} away={away} />);
    expect(html(true)).toMatch(
      /aria-label="Телефон ДДС"[^>]*hidden=""|hidden=""[^>]*aria-label="Телефон ДДС"/,
    );
    expect(html(false).includes('hidden=""')).toBe(false);
  });

  it("финальная смена: бригада и пропущенный не выдают номер карточки", () => {
    const html = renderToStaticMarkup(
      <Phone
        rings={[ring]}
        missed={[{ ...missed, callId: "other" }]}
        final
        open
      />,
    );
    expect(html).not.toContain("70005101");
    expect(html).toContain("Старший бригады · 201");
  });
});

describe("обновление линий без открытого окна и софтфона", () => {
  function Lines() {
    usePhoneLines([card, { ...card, id: "card-2" }], "101");
    return null;
  }

  it("проекция другой карточки даёт входящие и пропущенные обоих типов в общем телефоне", () => {
    const training: components["schemas"]["CardTraining"] = {
      card_id: card.id,
      revision: 1,
      selected_brigade_ids: [],
      messages: [],
      incoming: [
        {
          call_id: "brigade",
          brigade_id: "b1",
          call_target_id: "t1",
          started_at: control.control.started_at,
        },
      ],
      control: control.control,
    };
    mocks.queries.mockReturnValue([{ data: training }, {}]);
    function Incoming() {
      const lines = usePhoneLines([card, { ...card, id: "other-card" }], "101");
      return <Phone {...lines} />;
    }
    expect(renderToStaticMarkup(<Incoming />)).toContain(
      'aria-label="Телефон: входящих 2"',
    );
    mocks.queries.mockReturnValue([
      {
        data: {
          ...training,
          incoming: [],
          callbacks: [
            {
              ...training.incoming?.[0],
              call_id: "brigade",
              brigade_id: "b1",
              call_target_id: "t1",
              started_at: control.control.started_at,
              answered_at: null,
              ended_at: "2026-10-18T14:28:56Z",
              end_reason: "missed",
            },
          ],
          control: {
            ...control.control,
            ended_at: "2026-10-18T14:28:56Z",
            end_reason: "missed",
          },
        },
      },
      {},
    ]);
    const html = renderToStaticMarkup(<Incoming />);
    expect(html).toContain('aria-label="Телефон: пропущенных 2"');
    expect(html.match(/data-line="missed"/g)).toHaveLength(2);
  });

  it("call.state и training.updated обновляют свою карточку, snapshot — все; есть резервное чтение", () => {
    mocks.queries.mockReturnValue([]);
    renderToStaticMarkup(<Lines />);
    const unsubscribe = vi.fn();
    mocks.subscribe.mockReturnValue(unsubscribe);
    const cleanup = vi.mocked(useEffect).mock.calls[0][0]();
    const receive = mocks.subscribe.mock.calls[0][0] as (
      event: ServerEvent,
    ) => void;
    // От call.state нужны только card_id: наличие brigade_id не требуется.
    receive({
      type: "call.state",
      payload: { card_id: card.id },
    } as ServerEvent);
    receive({
      type: "training.updated",
      payload: { card_id: "card-2" },
    } as ServerEvent);
    receive({
      type: "call.state",
      payload: { card_id: "foreign" },
    } as ServerEvent);
    expect(mocks.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ["card-training", card.id] }],
      [{ queryKey: ["card-training", "card-2"] }],
    ]);
    receive({ type: "snapshot" } as ServerEvent);
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(4);
    expect(mocks.queries.mock.calls[0][0].queries).toEqual([
      expect.objectContaining({ refetchInterval: 5000 }),
      expect.objectContaining({ refetchInterval: 5000 }),
    ]);
    if (typeof cleanup === "function") cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
