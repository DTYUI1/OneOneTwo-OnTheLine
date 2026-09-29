import { describe, expect, it } from "vitest";
import { pickMimeType, recordingStatus } from "./recorder";
import { uploadOutcome } from "./upload";

const full = {
  secureContext: true,
  mediaDevices: true,
  mediaRecorder: true,
} as const;

describe("Доступность записи доклада", () => {
  it("на исправном АРМ пишет без пояснений", () => {
    expect(recordingStatus(full)).toEqual({ available: true, note: null });
  });

  it("без защищённого соединения объясняет и не винит обучаемого", () => {
    const status = recordingStatus({ ...full, secureContext: false });
    expect(status.available).toBe(false);
    expect(status.note).toContain("защищённому соединению");
    expect(status.note).toContain("засчитается");
  });

  it("без MediaRecorder и без микрофона тоже не падает", () => {
    for (const env of [
      { ...full, mediaRecorder: false },
      { ...full, mediaDevices: false },
    ])
      expect(recordingStatus(env)).toEqual({
        available: false,
        note: expect.stringContaining("Браузер не записывает звук"),
      });
  });

  it("небезопасный контекст не перебивает отсутствие самой записи", () => {
    expect(
      recordingStatus({
        secureContext: false,
        mediaDevices: false,
        mediaRecorder: false,
      }).note,
    ).toContain("Браузер не записывает звук");
  });
});

describe("Формат записи", () => {
  it("берёт первый поддерживаемый формат из контрактного списка", () => {
    expect(pickMimeType((type) => type.startsWith("audio/"))).toBe(
      "audio/webm;codecs=opus",
    );
    expect(pickMimeType((type) => type === "audio/ogg")).toBe("audio/ogg");
  });

  it("без поддержки отдаёт undefined — выбор остаётся за браузером", () => {
    expect(pickMimeType(() => false)).toBeUndefined();
  });
});

describe("Ответ сервера на загрузку", () => {
  it("успех закрывает вопрос", () => {
    expect(uploadOutcome(200)).toEqual({
      ok: true,
      retryable: false,
      note: null,
    });
  });

  it("звонок ещё не закрыт сервером — придержать и повторить", () => {
    // upload_audio отвечает 409, пока `ended_at` пуст: отбой ещё в очереди.
    for (const status of [409, 401, 403, 500, 501, 0]) {
      const result = uploadOutcome(status);
      expect(result.retryable, `статус ${status}`).toBe(true);
      expect(result.note).toContain("сохранена");
    }
  });

  it("отказ по существу не копит запись без толку", () => {
    for (const status of [413, 422]) {
      expect(uploadOutcome(status).retryable, `статус ${status}`).toBe(false);
      expect(uploadOutcome(status).note).toContain("не принял");
    }
  });
});
