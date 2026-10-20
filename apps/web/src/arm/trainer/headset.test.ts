import { describe, expect, it } from "vitest";
import { headsetVerdict } from "./headset";

describe("headsetVerdict", () => {
  it("показывает распознанную фразу", () => {
    const verdict = headsetVerdict({
      text: " Проверка связи ",
      confidence: 0.9,
      loudness: "ok",
    });
    expect(verdict).toEqual({
      ok: true,
      said: "Вы сказали: «Проверка связи»",
      note: "Микрофон работает.",
    });
  });
  it("тихий голос — не готово, но фраза показана", () => {
    const verdict = headsetVerdict({
      text: "алло",
      confidence: null,
      loudness: "quiet",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.said).toBe("Вы сказали: «алло»");
  });
  it("тишина — фразы нет", () => {
    expect(
      headsetVerdict({ text: "", confidence: null, loudness: null }).said,
    ).toBeNull();
  });
});
