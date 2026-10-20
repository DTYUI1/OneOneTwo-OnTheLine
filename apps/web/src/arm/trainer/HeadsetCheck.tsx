// Проверка гарнитуры (TC-14): тон в наушниках слева и справа, фраза в
// микрофон, «Вы сказали: «…»». Микрофон открывается на фразу (phraseRecorder), результат
// нигде не сохраняется. Распознавание выключено на сервере — проверяется только уровень.
import { useCallback, useEffect, useRef, useState } from "react";
import { csrfToken } from "../../shared/api";
import { Dialog } from "../Dialog";
import { headsetTestSignal } from "../signals";
import {
  createPhraseRecorder,
  type PhraseRecorder,
} from "../softphone/phraseRecorder";
import { PROBLEM, type Loudness } from "../softphone/voiceReport";
import { HEADSET_PHRASE, headsetVerdict, type HeadsetReply } from "./headset";
import styles from "./Support.module.css";
import dialogStyles from "./Trainer.module.css";

type Step = "idle" | "recording" | "recognizing";

export function HeadsetButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        Проверка гарнитуры
      </button>
      {open && (
        <div className={dialogStyles.back}>
          <Dialog
            label="Проверка гарнитуры"
            className={dialogStyles.modal}
            onClose={() => setOpen(false)}
          >
            <h2>Проверка гарнитуры</h2>
            <div>
              <HeadsetCheck />
            </div>
            <div className={dialogStyles.actions}>
              <button
                type="button"
                className={dialogStyles.btn}
                onClick={() => setOpen(false)}
              >
                Закрыть
              </button>
            </div>
          </Dialog>
        </div>
      )}
    </>
  );
}

async function recognize(blob: Blob): Promise<HeadsetReply | "off" | "failed"> {
  const form = new FormData();
  form.append("audio", blob, "headset");
  try {
    const response = await fetch("/api/headset-check", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken() },
      body: form,
    });
    if (response.status === 503) return "off";
    if (!response.ok) return "failed";
    const data = (await response.json()) as {
      text: string;
      confidence: number | null;
      loudness: Loudness | null;
    };
    return data;
  } catch {
    return "failed";
  }
}

export function HeadsetCheck() {
  const [step, setStep] = useState<Step>("idle");
  const [level, setLevel] = useState(0);
  const [said, setSaid] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const recorder = useRef<PhraseRecorder | null>(null);

  useEffect(() => () => recorder.current?.cancel(), []);

  useEffect(() => {
    if (step !== "recording") {
      setLevel(0);
      return;
    }
    let frame = requestAnimationFrame(function tick() {
      setLevel(recorder.current?.level() ?? 0);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [step]);

  const finish = useCallback(async () => {
    const active = recorder.current;
    recorder.current = null;
    if (!active) return;
    setStep("recognizing");
    const blob = await active.stop();
    const reply = blob ? await recognize(blob) : "failed";
    setStep("idle");
    if (reply === "off") {
      setSaid(null);
      setNote(
        "Распознавание речи на сервере выключено: микрофон записал звук, но фразу показать нечем.",
      );
    } else if (reply === "failed") {
      setSaid(null);
      setNote("Не удалось проверить фразу. Повторите.");
    } else {
      const verdict = headsetVerdict(reply);
      setSaid(verdict.said);
      setNote(verdict.note);
    }
  }, []);

  const start = useCallback(() => {
    if (step === "recording") {
      void finish();
      return;
    }
    if (step !== "idle") return;
    const next = createPhraseRecorder();
    recorder.current = next;
    setSaid(null);
    setNote(null);
    setStep("recording");
    void next
      .start(() => void finish())
      .then((problem) => {
        if (problem === null) return;
        recorder.current = null;
        setStep("idle");
        setNote(PROBLEM[problem]);
      });
  }, [step, finish]);

  return (
    <div className={styles.voice} data-headset-check="" aria-live="polite">
      <div className={styles.src}>Проверка гарнитуры</div>
      <p>
        Нажмите «Проверить наушники» — тон прозвучит слева, затем справа. Потом
        нажмите «Проверить микрофон» и скажите: «{HEADSET_PHRASE}»
      </p>
      <div className={styles.btns}>
        <button
          type="button"
          className={styles.btn}
          onClick={headsetTestSignal}
        >
          Проверить наушники
        </button>
        <button
          type="button"
          className={styles.main}
          disabled={step === "recognizing"}
          onClick={start}
        >
          {step === "recording" ? "Готово" : "Проверить микрофон"}
        </button>
      </div>
      {step === "recording" && (
        <div
          className={styles.level}
          role="meter"
          aria-label="Уровень микрофона"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
        >
          <div
            className={styles.levelFill}
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
      )}
      {step === "recognizing" && <p className={styles.note}>Проверяем…</p>}
      {said && <p data-headset-said="">{said}</p>}
      {note && <p className={styles.note}>{note}</p>}
    </div>
  );
}
