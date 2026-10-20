// Разговор с отделом контроля реагирования (TC-07; памятка ДДС, с. 26–28) в окне телефона ДДС.
// Отдел контроля спрашивает, почему карточка без статуса; диспетчер поясняет голосом или
// вариантом (событие control_reply), отдел контроля прощается фразой банка и кладёт трубку.
// Пока идёт разговор, тело карточки в окне скрыто, а переход к другой карточке кладёт трубку
// (callGuard). Ответ на другой вызов ставит разговор на удержание (вкладки 17.10): отдел
// контроля ждёт молча, после снятия — «Да, слушаю.» и ждёт пояснения дальше.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CardEvent } from "../../shared/api";
import { useSession } from "../../shared/session";
import { setActiveCall } from "../callGuard";
import { LINE_WAIT_MS } from "../pickup";
import { useNow } from "../useNow";
import { bankAudio } from "../softphone/bank";
import { useVoiceReply } from "../softphone/brigade/useVoiceReply";
import { createVoices, type Voices } from "../softphone/voices";
import { officialBackPhrase } from "../softphone/heldTalk";
import { micStatus } from "../softphone/voiceReport";
import {
  CONTROL_ASK_ID,
  CONTROL_BYE_ID,
  CONTROL_EXT,
  CONTROL_HANGUP_MS,
  CONTROL_NAME,
  controlBye,
  controlNote,
  controlQuestion,
  controlWaited,
  talking,
} from "./control";
import type { ControlLine } from "./PhoneWindow";
import { CONTROL_WHO } from "./lines";
import { CallFooter } from "./CallFooter";
import styles from "./Phone.module.css";

type Said = { readonly mode: "voice" | "parts"; readonly text: string };

export function ControlTalk({
  cardId,
  callId,
  line,
  resumed = false,
  onResume,
  onDone,
}: {
  readonly cardId: string;
  readonly callId: string;
  /** Снят с удержания (вкладки 17.10): вопрос уже звучал, отдел контроля снова на связи. */
  readonly resumed?: boolean;
  /** Получатель готов: владелец удержания разрешает передачу, не ACK outbox. */
  readonly onResume?: () => boolean;
  /** Карточка и звонок из учебных сведений; до их обновления — null. */
  readonly line: ControlLine | null;
  /** Разговор кончился: окно возвращается к карточке. */
  readonly onDone: () => void;
}) {
  const { realtime } = useSession();
  const control = line?.control ?? null;
  // Пояснение уходит, только когда сервер уже видит разговор: иначе отказ остановит
  // очередь событий карточки (outbox).
  const available = talking(control);
  const [accepted, setAccepted] = useState(!resumed || onResume === undefined);
  const ready = available && accepted;
  const ended = control?.ended_at != null;
  const [said, setSaid] = useState<Said | null>(null);
  const [unclear, setUnclear] = useState(false);
  const closed = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;
  const accept = useRef(onResume);
  accept.current = onResume;
  useEffect(() => {
    if (!resumed || accepted || closed.current || !available) return;
    if (accept.current?.() === false) {
      closed.current = true;
      done.current();
    } else setAccepted(true);
  }, [available, resumed, accepted]);
  useEffect(() => {
    if (!resumed || accepted) return;
    const timer = setTimeout(() => {
      if (closed.current) return;
      closed.current = true;
      done.current();
    }, LINE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [resumed, accepted]);

  const send = useCallback(
    (type: CardEvent["type"], payload: Record<string, unknown>) =>
      void realtime.enqueue(cardId, {
        client_event_id: crypto.randomUUID(),
        client_ts: new Date().toISOString(),
        type,
        payload,
      } as CardEvent),
    [realtime, cardId],
  );
  const hangup = useCallback(async () => {
    if (closed.current) return;
    closed.current = true;
    if (!resumed || accepted) send("call_hangup", { call_id: callId });
    done.current();
  }, [send, callId, resumed, accepted]);

  // Сервер закончил звонок сам (занятие завершено) — окно возвращается к карточке.
  useEffect(() => {
    if (ended && !closed.current) {
      closed.current = true;
      done.current();
    }
  }, [ended]);
  // Один разговор на АРМ: переход к другой карточке кладёт эту трубку, ответ на другой
  // вызов — ставит на удержание (пока пояснения не было: после него отдел контроля прощается).
  const holdableRef = useRef(false);
  const cardNumber = line?.card.source.number ?? "";
  useEffect(() => {
    if ((resumed && !accepted) || closed.current) return;
    setActiveCall({
      cardId,
      label: "с отделом контроля",
      hangup,
      hold: () => {
        if (!holdableRef.current || closed.current) return null;
        closed.current = true;
        voices.current?.cancel();
        return {
          cardId,
          cardNumber,
          callId,
          kind: "control",
          phoneExt: CONTROL_EXT,
          who: CONTROL_WHO,
          saved: null,
        };
      },
    });
    return () => setActiveCall(null);
  }, [cardId, cardNumber, callId, hangup, resumed, accepted]);
  // Голос отдела контроля — записи банка: вопрос, когда разговор начался, отбой после
  // пояснения; трубка кладётся, когда отбой отзвучал (не дольше CONTROL_HANGUP_MS сверх него).
  const voices = useRef<Voices | null>(null);
  useEffect(() => {
    voices.current = createVoices();
    return () => {
      voices.current?.cancel();
      voices.current = null;
    };
  }, []);
  const asked = useRef(false);
  const back = resumed ? officialBackPhrase(null) : null;
  useEffect(() => {
    if (!ready || asked.current || closed.current) return;
    asked.current = true;
    // Снят с удержания: вопрос уже звучал — «Да, слушаю.» общего дежурного (номер 112).
    const url = resumed
      ? officialBackPhrase(null).url
      : bankAudio(CONTROL_ASK_ID);
    if (url) void voices.current?.playAsset(url, 0);
  }, [ready, resumed]);
  useEffect(() => {
    if (!said) return;
    let gone = false;
    const timer = setTimeout(() => void hangup(), CONTROL_HANGUP_MS * 4);
    const url = bankAudio(CONTROL_BYE_ID);
    voices.current?.cancel();
    void (
      url && voices.current
        ? voices.current.playAsset(url, CONTROL_HANGUP_MS)
        : new Promise((done) => setTimeout(done, CONTROL_HANGUP_MS))
    ).then(() => {
      if (!gone) void hangup();
    });
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [said, hangup]);

  const reply = (
    mode: Said["mode"],
    text: string,
    optionKey: string | null,
  ) => {
    if (said || !ready) return;
    setSaid({ mode, text });
    send("control_reply", {
      call_id: callId,
      mode,
      text,
      option_key: optionKey,
    });
  };
  holdableRef.current = ready && !said;
  const voice = useVoiceReply({
    callId: ready && !said ? callId : null,
    question: null,
    free: true,
    voiceOnly: false,
    onHeard: () => {},
    onUnclear: () => setUnclear(true),
    onSaid: (text) =>
      text.trim() ? reply("voice", text.trim(), null) : setUnclear(true),
  });
  const note = controlNote(voice.problem, unclear);
  const recording = voice.status === "recording";
  const [recStart, setRecStart] = useState<number | null>(null);
  useEffect(() => setRecStart(recording ? Date.now() : null), [recording]);
  const recNow = useNow(250);

  let answer;
  if (!ready)
    answer = (
      <span className={styles.status}>
        <span className={styles.spin} />
        Соединяем…
      </span>
    );
  else if (said)
    answer = (
      <span className={styles.status} role="status">
        Отдел контроля кладёт трубку.
      </span>
    );
  else if (voice.status === "recording")
    answer = (
      <>
        <button
          type="button"
          className={styles.talkBtn}
          data-rec="true"
          onClick={voice.toggle}
        >
          Закончить ответ
        </button>
        <span className={styles.status} role="status">
          {micStatus(
            "recording",
            false,
            false,
            recStart === null ? 0 : recNow - recStart,
          )}
        </span>
      </>
    );
  else
    answer = (
      <>
        <button
          type="button"
          className={styles.talkBtn}
          disabled={voice.status === "recognizing" || voice.problem !== null}
          title={
            voice.status === "recognizing"
              ? "Идёт распознавание — подождите"
              : voice.problem !== null
                ? "Микрофон недоступен: ответьте вариантом ответа"
                : undefined
          }
          onClick={voice.toggle}
        >
          Говорить
        </button>
        <button
          type="button"
          className={styles.partsBtn}
          aria-pressed={voice.choices}
          disabled={voice.status === "recognizing"}
          title={
            voice.status === "recognizing"
              ? "Идёт распознавание — подождите"
              : undefined
          }
          onClick={voice.openChoices}
        >
          По частям
        </button>
        {voice.status === "recognizing" && (
          <span className={styles.status}>
            <span className={styles.spin} />
            {micStatus("recognizing", false)}
          </span>
        )}
        {voice.choices && (
          <span
            className={styles.group}
            role="group"
            aria-label="Варианты пояснения"
          >
            {(control?.reply_options ?? []).map((option) => (
              <button
                key={option.key}
                type="button"
                className={styles.question}
                onClick={() => reply("parts", option.label, option.key)}
              >
                {option.label}
              </button>
            ))}
          </span>
        )}
        {note && (
          <span className={styles.status} role="status">
            {note}
          </span>
        )}
      </>
    );

  return (
    <section
      className={styles.control}
      aria-label="Разговор с отделом контроля"
      data-help="phone-control"
      data-control-call={ready ? "talking" : "connecting"}
    >
      <div className={styles.lineRow} data-line="control">
        <span>
          <b>
            {CONTROL_NAME} · {CONTROL_EXT}
          </b>{" "}
          · разговор
          {line ? ` · по карточке ${line.card.source.number}` : ""}
        </span>
      </div>
      <div className={styles.talkLog}>
        <ol>
          {line && control && (
            <li className={styles.sys}>
              {controlWaited(control.without_status_s)}
            </li>
          )}
          {ready && (
            <li>
              <span className={styles.who}>Отдел контроля:</span>{" "}
              {controlQuestion()}
            </li>
          )}
          {ready && back && (
            <li className={styles.sys}>Снят с удержания: {CONTROL_NAME}</li>
          )}
          {ready && back && (
            <li>
              <span className={styles.who}>Отдел контроля:</span> {back.text}
            </li>
          )}
          {said && (
            <li>
              <span className={styles.me}>Вы:</span> {said.text}
            </li>
          )}
          {said && (
            <li>
              <span className={styles.who}>Отдел контроля:</span> {controlBye()}
            </li>
          )}
        </ol>
      </div>
      <CallFooter onHangup={() => void hangup()}>{answer}</CallFooter>
    </section>
  );
}
