import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";
import { IncidentCard } from "./IncidentCard";
import type { Card, CardEvent } from "../shared/api";

const mocks = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0,
  refetch: vi.fn(),
  post: vi.fn(),
  enqueue: vi.fn<(cardId: string, event: CardEvent) => Promise<void>>(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const i = mocks.index++;
    if (!(i in mocks.states)) mocks.states[i] = initial;
    return [
      mocks.states[i],
      (value: unknown) => {
        mocks.states[i] =
          typeof value === "function" ? value(mocks.states[i]) : value;
      },
    ];
  },
  useRef: (current: unknown) => ({ current }),
  useMemo: (compute: () => unknown) => compute(),
  useCallback: (callback: unknown) => callback,
  useEffect: vi.fn(),
  useLayoutEffect: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) =>
    queryKey[0] === "card-training"
      ? { refetch: mocks.refetch }
      : { data: [], refetch: vi.fn() },
  useQueryClient: () => ({
    cancelQueries: vi.fn(),
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  }),
}));
vi.mock("../shared/api", () => ({
  api: { POST: mocks.post },
  csrfToken: () => "csrf",
}));
vi.mock("../shared/session", () => ({
  useSession: () => ({
    user: { id: "user" },
    realtime: { enqueue: mocks.enqueue, pending: async () => [] },
  }),
}));
vi.mock("./useParticipant", () => ({
  useParticipant: () => ({
    canAct: true,
    participant: { dds_service_id: "101" },
  }),
}));
vi.mock("./useSpellingHints", () => ({ useSpellingHints: () => [] }));
vi.mock("./tools/CardTools", () => ({ useCardTools: () => ({}) }));
vi.mock("./useNow", () => ({ useNow: () => 1000 }));

const card = {
  id: "card",
  session_id: "session",
  trainee_id: "user",
  state: "working",
  current: { service_number: "", comment: "" },
  source: { number: "100", address: {}, tags: [], service_ids: ["101"] },
} as unknown as Card;

function confirm(node: ReactNode): (() => void) | null {
  for (const child of Children.toArray(node)) {
    if (
      !isValidElement<{
        children?: ReactNode;
        "data-help"?: string;
        onClick?: () => void;
      }>(child)
    )
      continue;
    if (child.props["data-help"] === "line-confirm")
      return child.props.onClick ?? null;
    const found = confirm(child.props.children);
    if (found) return found;
  }
  return null;
}
function click() {
  mocks.index = 0;
  const press = confirm(
    IncidentCard({ card, services: [], onClose: vi.fn(), onReview: vi.fn() }),
  );
  if (!press) throw new Error("Нет кнопки подтверждения");
  press();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.states = [
    "status",
    "completed",
    "2",
    "Работы завершены",
    "",
    "",
    false,
  ];
  mocks.index = 0;
  mocks.post.mockResolvedValue({ data: card });
  mocks.enqueue.mockResolvedValue(undefined);
  vi.stubGlobal("document", { activeElement: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("проверка доклада без мутации статуса (PR3-05)", () => {
  it("отказ локальной проверки не отправляет status_change даже если доклад уже появился на сервере", async () => {
    mocks.refetch.mockResolvedValue({
      data: { missing_report_states: ["completed"] },
    });
    click();
    await vi.waitFor(() =>
      expect(mocks.states[5]).toContain(
        "Сначала получите и прослушайте доклад",
      ),
    );
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.states[6]).toBe(false);
  });
  it("успешная проверка сначала требует второй ✓, затем сохраняет наряд перед статусом через outbox", async () => {
    mocks.refetch.mockResolvedValue({ data: { missing_report_states: [] } });
    click();
    await vi.waitFor(() => expect(mocks.states[6]).toBe(true));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    click();
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(2));
    expect(
      mocks.enqueue.mock.calls.map(
        ([, event]: [string, CardEvent]) => event.type,
      ),
    ).toEqual(["field_change", "status_change"]);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
