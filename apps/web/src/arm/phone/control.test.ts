import { describe, expect, it } from "vitest";
import {
  clock,
  controlBye,
  controlNote,
  controlQuestion,
  controlWaited,
  controlReview,
  ringing,
  missed,
  talking,
  type ControlCall,
} from "./control";

const base: ControlCall = {
  call_id: "c1",
  started_at: "2026-10-17T09:01:05Z",
  answered_at: null,
  ended_at: null,
  end_reason: null,
  without_status_s: 65,
  reply_options: [{ key: "late", label: "Не успел обработать" }],
  reply: null,
};

describe("звонок отдела контроля (TC-07)", () => {
  it("пропущенный виден только после окончания без ответа, остановка занятия не считается пропуском", () => {
    expect(missed(base)).toBe(false);
    expect(missed(null)).toBe(false);
    const ended = {
      ...base,
      ended_at: "2026-10-17T09:01:30Z",
      end_reason: "missed" as const,
    };
    expect(missed(ended)).toBe(true);
    expect(missed({ ...ended, answered_at: "2026-10-17T09:01:10Z" })).toBe(
      false,
    );
    expect(missed({ ...ended, end_reason: "session_finished" })).toBe(false);
  });
  it("звонит, идёт разговор, кончился", () => {
    expect(ringing(base)).toBe(true);
    expect(talking(base)).toBe(false);
    const answered = { ...base, answered_at: "2026-10-17T09:01:10Z" };
    expect(ringing(answered)).toBe(false);
    expect(talking(answered)).toBe(true);
    const ended = { ...answered, ended_at: "2026-10-17T09:01:30Z" };
    expect(talking(ended)).toBe(false);
    expect(ringing(null)).toBe(false);
  });

  it("вопрос и отбой — фразы банка, время без статуса — подпись", () => {
    expect(clock(65)).toBe("1:05");
    expect(controlQuestion()).toBe(
      "Диспетчер, отдел контроля реагирования. Почему карточка так долго без статуса? Поясните причину.",
    );
    expect(controlWaited(65)).toBe("Карточка без статуса 1:05.");
    expect(controlBye()).toBe("Принято. Отбой.");
  });

  it("строка разбора: без статуса сколько и что ответили", () => {
    const head = "Отдел контроля звонил: карточка была без статуса 1:05.";
    expect(controlReview(null)).toBeNull();
    expect(
      controlReview({
        ...base,
        ended_at: "2026-10-17T09:01:30Z",
        end_reason: "missed",
      }),
    ).toBe(`${head} Вызов остался без ответа.`);
    expect(
      controlReview({
        ...base,
        answered_at: "2026-10-17T09:01:10Z",
        ended_at: "2026-10-17T09:01:30Z",
      }),
    ).toBe(`${head} Пояснения не было.`);
    expect(
      controlReview({
        ...base,
        answered_at: "2026-10-17T09:01:10Z",
        reply: {
          mode: "parts",
          text: "Не успел обработать",
          option_key: "late",
          at: "2026-10-17T09:01:20Z",
        },
      }),
    ).toBe(`${head} Ваше пояснение: «Не успел обработать».`);
    expect(
      controlReview({
        ...base,
        answered_at: "2026-10-17T09:01:10Z",
        reply: {
          mode: "voice",
          text: "Сбой АРМ",
          option_key: null,
          at: "2026-10-17T09:01:20Z",
        },
      }),
    ).toBe(`${head} Ваше пояснение голосом: «Сбой АРМ».`);
  });
});

describe("пояснение под кнопкой отдела контроля", () => {
  it("голосом не вышло — вариант; не расслышали — повтор", () => {
    expect(controlNote(null, false)).toBeNull();
    expect(controlNote("server_off", false)).toMatch(
      /Выберите вариант пояснения\.$/,
    );
    expect(controlNote(null, true)).toBe(
      "Пояснение не расслышано. Повторите голосом или выберите вариант.",
    );
  });
});
