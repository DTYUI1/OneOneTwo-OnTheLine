import { describe, expect, it } from "vitest";
import { brigadePhrases } from "../bank";
import cases from "./confirmRequest.cases.json";
import {
  asksConfirmation,
  backOnLinePhrase,
  confirmRequestPhrase,
  confirmsReport,
  introPhrase,
  NO_REPLY_MS,
  noReplyPhrase,
  pauseKey,
  resumedPhrase,
  resumedSaid,
  resumedSay,
  holdsNews,
} from "./incoming";

const SERVICES = ["101", "102", "103", "104", "GKH", "MOSLIFT"];

describe("входящий доклад бригады: реплики из банка (TC-01)", () => {
  it("старший называет себя фразой места intro своей службы", () => {
    expect(introPhrase("101")).toBe("Старший расчёта, на связи.");
    expect(introPhrase("102")).toBe("Старший наряда на связи.");
    for (const service of SERVICES)
      expect(
        brigadePhrases(service, "intro").map((item) => item.text),
      ).toContain(introPhrase(service));
  });

  it("доклад кончается «Как приняли?», тишина — «Диспетчер, слышите меня?»", () => {
    for (const service of SERVICES) {
      expect(confirmRequestPhrase(service)).toBe("Как приняли?");
      expect(noReplyPhrase(service)).toBe("Диспетчер, слышите меня?");
    }
    // Служба без своей книги отвечает голосом пожарного расчёта (bank.ts).
    expect(introPhrase(null)).toBe(introPhrase("101"));
    expect(NO_REPLY_MS).toBe(8000);
  });
});

describe("«Принял» голосом — подтверждение приёма", () => {
  it.each([
    "Принял",
    "принято, спасибо",
    "Понял вас",
    "Записала",
    "Принял, не выезжайте",
    "Принял не выезжайте",
    "Не выезжайте, принял",
    "Не выезжайте. Понял",
    "Не выезжайте; записала",
    "Не выезжайте — принято",
  ])("«%s» — подтверждение", (text) => expect(confirmsReport(text)).toBe(true));

  it.each([
    "",
    "э-э",
    "Повторите доклад",
    "Понял, а где вы сейчас?",
    "Выезжайте",
    "непонятно",
    "Не понял, повторите",
    "Не совсем понял",
    "Не всё понял",
    "Не до конца понял",
    "Я вас не очень хорошо поняла",
    "Не полностью принял",
    "Ещё не всё записала",
    "Не совсем принято",
    "Расчёт, не до конца понял",
    "Не совсем понял и не всё записал",
    "Я не принял доклад",
    "Не записала",
    "Ничего не поняла",
    "Принялся за дело",
    "Понял?",
  ])("«%s» — не подтверждение", (text) =>
    expect(confirmsReport(text)).toBe(false),
  );
});

describe("пауза, в которой бригада ждёт ответа", () => {
  const base = { talking: true, asked: "d1", asks: 1, said: 0 };

  it("нет вопроса или разговора — переспрашивать некому", () => {
    expect(pauseKey({ ...base, asked: null })).toBeNull();
    expect(pauseKey({ ...base, talking: false })).toBeNull();
  });

  it("одна пауза — один ключ; новая фраза диспетчера или вопрос — новая пауза", () => {
    const first = pauseKey(base);
    expect(pauseKey(base)).toBe(first);
    expect(pauseKey({ ...base, said: 1 })).not.toBe(first);
    expect(pauseKey({ ...base, asks: 2 })).not.toBe(first);
  });
});

describe("снятие с удержания (TC-02)", () => {
  it("старший снова на связи — фраза места answer из банка", () => {
    expect(backOnLinePhrase("101")).toBe("Расчёт на связи.");
    expect(backOnLinePhrase("102")).toBe("Да, диспетчер, на связи.");
    for (const service of SERVICES) {
      const phrase = backOnLinePhrase(service);
      expect(
        brigadePhrases(service, "answer").map((item) => item.text),
      ).toContain(phrase);
      expect(phrase).toMatch(/на связи/i);
    }
  });

  it("ждал «Принял» — переспрашивает «Как приняли?», а не говорит поверх вопроса", () => {
    for (const service of SERVICES) {
      expect(resumedPhrase(service, false)).toBe(backOnLinePhrase(service));
      expect(resumedPhrase(service, true)).toBe(confirmRequestPhrase(service));
    }
  });

  // Вопрос бригады: срок ответа (срок события) — 30 с от того, как услышали.
  const question = {
    deliveryId: "q",
    text: "Хозяева дома будут?",
    url: "/assets/q.ogg",
    replyBy: 30_000,
  };

  it("вопрос в сроке — повтор записью его реплики (HQ-058)", () => {
    // Сервер ждёт ответа 8 с и уже выдал новость — бригада всё равно повторяет вопрос.
    expect(resumedSay("GKH", true, question, 12_000)).toEqual({
      text: question.text,
      url: question.url,
      repeated: "q",
      replyBy: 30_000,
      dropped: null,
    });
    const bank = { url: null, repeated: null, replyBy: null, dropped: null };
    expect(resumedSay("GKH", true, null, 12_000)).toEqual({
      text: confirmRequestPhrase("GKH"),
      ...bank,
    });
    expect(resumedSay("GKH", false, null, 12_000)).toEqual({
      text: backOnLinePhrase("GKH"),
      ...bank,
    });
  });

  it("срок истёк на удержании — «на связи», вопрос не повторён и снят (HQ-058)", () => {
    expect(resumedSay("GKH", false, question, 30_000)).toEqual({
      text: backOnLinePhrase("GKH"),
      url: null,
      repeated: null,
      replyBy: null,
      dropped: "q",
    });
    // Срока сервер не отдал — повтор, как в сроке.
    expect(
      resumedSay("GKH", false, { ...question, replyBy: null }, 99_000).repeated,
    ).toBe("q");
  });

  it("повторив вопрос, бригада придерживает новость до ответа или срока (HQ-058)", () => {
    const said = resumedSay("GKH", false, question, 12_000);
    expect(holdsNews(said, { deliveryId: "q" }, 12_000)).toBe(true);
    expect(holdsNews(said, { deliveryId: "q" }, 29_999)).toBe(true);
    // Срок прошёл — новость звучит.
    expect(holdsNews(said, { deliveryId: "q" }, 30_000)).toBe(false);
    // Ответили — вопроса нет (или открыт уже другой) — новость звучит.
    expect(holdsNews(said, null, 12_000)).toBe(false);
    expect(holdsNews(said, { deliveryId: "q2" }, 12_000)).toBe(false);
    // Не повторяла вопроса — не придерживает.
    const back = resumedSay("GKH", false, question, 31_000);
    expect(holdsNews(back, { deliveryId: "q" }, 31_000)).toBe(false);
    expect(holdsNews(null, { deliveryId: "q" }, 1)).toBe(false);
  });

  it("фраза снятия с удержания фиксируется в миг снятия", () => {
    const said = resumedSaid(
      null,
      "c@1",
      resumedSay("GKH", false, question, 1_000),
    );
    expect(said).toMatchObject({
      key: "c@1",
      text: question.text,
      url: question.url,
    });
    // Ответили кнопкой — вопроса больше нет, но бригада сказала его, а не «на связи».
    expect(
      resumedSaid(said, "c@1", resumedSay("GKH", false, null, 2_000)),
    ).toBe(said);
    // «Принял» сказан — фраза та же; новый вопрос позже — тоже не её текст.
    expect(
      resumedSaid(
        said,
        "c@1",
        resumedSay(
          "GKH",
          false,
          { deliveryId: "n", text: "Новый вопрос?", url: null, replyBy: null },
          3_000,
        ),
      ),
    ).toBe(said);
    // Разговор кончился — сказанное остаётся до нового снятия.
    expect(resumedSaid(said, "c@1", null)).toBe(said);
    // Ждал «Принял» при снятии — переспрос фиксируется так же.
    const asked = resumedSaid(
      said,
      "c@2",
      resumedSay("GKH", true, null, 4_000),
    );
    expect(asked?.text).toBe(confirmRequestPhrase("GKH"));
    expect(
      resumedSaid(asked, "c@2", resumedSay("GKH", false, null, 5_000)),
    ).toBe(asked);
    // Новое снятие (новый ключ) — фраза заново; не снят с удержания — ничего.
    expect(
      resumedSaid(asked, "c@3", resumedSay("GKH", false, null, 6_000))?.text,
    ).toBe(backOnLinePhrase("GKH"));
    expect(resumedSaid(null, "d@1", null)).toBeNull();
  });

  it("второе снятие в том же звонке — вопрос повторяется снова (HQ-058)", () => {
    const first = resumedSaid(
      null,
      "c@1",
      resumedSay("GKH", false, question, 5_000),
    );
    // Снова на удержание и снова сняли (новое начало разговора) — вопрос ещё без ответа.
    const second = resumedSaid(
      first,
      "c@2",
      resumedSay("GKH", false, question, 20_000),
    );
    expect(second).not.toBe(first);
    expect(second).toMatchObject({
      key: "c@2",
      text: question.text,
      repeated: "q",
    });
  });

  it("ждал ответа на вопрос с вариантами — повторяет вопрос (HQ-058)", () => {
    const question = "Хозяева дома будут?";
    for (const service of SERVICES) {
      expect(resumedPhrase(service, false, question)).toBe(question);
      expect(resumedPhrase(service, false, null)).toBe(
        backOnLinePhrase(service),
      );
    }
  });
});

describe("«Как приняли?» — общая таблица с сервером (confirmRequest.cases.json)", () => {
  it.each(cases.cases)("$what", (item) =>
    expect(
      asksConfirmation({
        inbound: item.inbound,
        question: item.question,
        answer: item.answer,
      }),
    ).toBe(item.asks),
  );
});
