import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "../../shared/api";
import { ControlTalk } from "./ControlTalk";
import type { ControlLine } from "./PhoneWindow";

vi.mock("../../shared/session", () => ({
  useSession: () => ({ realtime: { enqueue: vi.fn() } }),
}));
vi.mock("../softphone/brigade/useVoiceReply", () => ({
  useVoiceReply: () => ({
    status: "idle",
    problem: null,
    choices: true,
    toggle: vi.fn(),
    openChoices: vi.fn(),
  }),
}));

const line: ControlLine = {
  card: { id: "card-1", source: { number: "70005101" } } as Card,
  control: {
    call_id: "control-1",
    started_at: "2026-10-18T14:28:31Z",
    answered_at: "2026-10-18T14:28:36Z",
    ended_at: null,
    end_reason: null,
    without_status_s: 60,
    reply_options: [{ key: "working", label: "Уточняю сведения" }],
    reply: null,
  },
};

describe("отбой отдела контроля на нижней плашке", () => {
  it.each([false, true])(
    "после снятия с удержания: %s — одна отдельная кнопка справа от ответа",
    (resumed) => {
      const html = renderToStaticMarkup(
        <ControlTalk
          cardId="card-1"
          callId="control-1"
          line={line}
          resumed={resumed}
          onDone={vi.fn()}
        />,
      );
      const footer = html.match(
        /<div[^>]*aria-label="Действия разговора"[\s\S]*$/,
      )?.[0];
      expect(footer).toBeDefined();
      expect(footer).toContain('aria-label="Положить трубку"');
      expect(footer).toContain('aria-label="Ответ"');
      expect(footer).toContain("Уточняю сведения");
      expect(footer?.indexOf('aria-label="Положить трубку"')).toBeGreaterThan(
        footer?.indexOf('aria-label="Ответ"') ?? -1,
      );
      expect(html.match(/aria-label="Положить трубку"/g)).toHaveLength(1);
      expect(footer).toMatch(/<svg[^>]*aria-hidden="true"/);
      expect(html.split('aria-label="Действия разговора"')[0]).not.toContain(
        "Положить трубку",
      );
      if (resumed) expect(html).toContain("Снят с удержания");
    },
  );
});
