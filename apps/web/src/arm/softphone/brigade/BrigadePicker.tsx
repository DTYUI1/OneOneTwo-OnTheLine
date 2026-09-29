// Панель бригад рядом с телефоном. Ничего не решает за обучаемого: он сам
// выбирает бригады, звонит им, слушает доклады и сам переносит сведения в карточку.

import type { components } from "../../../api-client/schema";
import { STATE_LABELS } from "../../cardModel";
import { stateLabel } from "./logic";
import type { BrigadeView } from "./useBrigade";
import styles from "./BrigadePicker.module.css";

export function BrigadePicker({
  brigade,
  talkingTo,
  canDial,
  onDial,
}: {
  brigade: BrigadeView;
  /** Адресат текущего разговора, если это бригада; иначе `null`. */
  talkingTo: components["schemas"]["CallTarget"] | null;
  /** Линия свободна и действия разрешены. */
  canDial: boolean;
  onDial: (phoneExt: string) => void;
}) {
  if (!brigade.available) return null;

  const chosen = brigade.committed.length > 0;
  const dirty =
    brigade.selected.length !== brigade.committed.length ||
    brigade.selected.some((id) => !brigade.committed.includes(id));
  const current = brigade.current;
  const text = current?.delivery.message;

  return (
    <section className={styles.panel} aria-label="Бригады службы">
      <p className={styles.title}>Какие бригады нужны</p>

      {/* Табло сил (28.09): у каждой бригады номер и состояние — кто свободен,
          видно заранее, до решения по карточке. Бригада на другом незакрытом
          происшествии сюда не едет. */}
      <div className={styles.list}>
        {brigade.board.map((row) => (
          <label
            key={row.id}
            className={`${styles.row} ${row.state === "busy" ? styles.busy : ""}`}
          >
            <input
              type="checkbox"
              checked={brigade.selected.includes(row.id)}
              disabled={row.state === "busy"}
              onChange={() => brigade.toggle(row.id)}
            />
            <span>{row.name}</span>
            {row.ext && <span className={styles.ext}>{row.ext}</span>}
            <span
              className={`${styles.state} ${row.state === "here" ? styles.here : ""}`}
            >
              {stateLabel(row)}
            </span>
          </label>
        ))}
      </div>

      <button
        type="button"
        className={styles.commit}
        onClick={brigade.commit}
        disabled={
          brigade.block !== null || brigade.selected.length === 0 || !dirty
        }
      >
        {chosen ? "Изменить набор" : "Направить выбранные"}
      </button>
      {/* Бригаду направляют после решения реагировать (памятка ДДС, стр. 21). */}
      {brigade.block && <p className={styles.block}>{brigade.block}</p>}
      {brigade.commitNote && (
        <p className={styles.note} role="alert">
          {brigade.commitNote}
        </p>
      )}

      {chosen && (
        <p className={styles.chosen}>
          Направлено бригад: {brigade.committed.length}. Статус карточки от
          этого не меняется — его ставите вы.
        </p>
      )}

      {brigade.targets.length > 0 && (
        <ul className={styles.targets} aria-label="Связь с бригадами">
          {brigade.targets.map((target) => (
            <li key={target.id} className={styles.target}>
              <span>
                {target.name}
                <span className={styles.ext}> · {target.phone_ext}</span>
              </span>
              <button
                type="button"
                className={styles.call}
                disabled={!canDial}
                onClick={() => onDial(target.phone_ext)}
              >
                Позвонить
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Принятые доклады показаны у телефонной полосы (Softphone.tsx): они
          нужны и со свёрнутой панелью, когда по ним пишется комментарий.
          Сколько докладов будет всего — знает только сервер, поэтому «ждём»
          говорится лишь до первого из них, дальше говорят сами доклады. */}
      {/* Бригада действует по решению диспетчера: следующий доклад придёт только
          после статуса в карточке. Подсказка — лишь в занятии с подсказками. */}
      {chosen && !current && brigade.awaiting && (
        <p className={styles.wait} role="status">
          Бригада ждёт вашего решения: отметьте в карточке статус «
          {STATE_LABELS[brigade.awaiting]}» — после этого она доложит дальше.
        </p>
      )}

      {chosen &&
        !current &&
        !brigade.awaiting &&
        brigade.accepted.length === 0 && (
          <p className={styles.wait}>
            {talkingTo
              ? "Ожидаем доклад, если он предусмотрен учебным сценарием."
              : "Позвоните бригаде. Доклад поступит во время разговора, если он предусмотрен учебным сценарием."}
          </p>
        )}

      {current && text && (
        <div className={styles.message}>
          <p className={styles.from}>Бригада докладывает</p>
          <p className={styles.text}>{text.text}</p>
          {text.audio === null ? (
            <>
              <p className={styles.hint}>
                Доклад пришёл текстом. Прочитайте его и подтвердите.
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.commit}
                  onClick={brigade.confirmRead}
                >
                  Прочитал доклад
                </button>
              </div>
            </>
          ) : brigade.playing ? (
            <p className={styles.hint}>Звучит…</p>
          ) : brigade.listening ? (
            <p className={styles.hint}>
              Бригада слушает вас и доложит, когда вы договорите.
            </p>
          ) : (
            <>
              <p className={styles.hint}>
                Доклад засчитывается только после того, как прозвучал целиком.
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.commit}
                  onClick={brigade.replay}
                >
                  Прослушать ещё раз
                </button>
              </div>
            </>
          )}
          {brigade.note && <p className={styles.note}>{brigade.note}</p>}
        </div>
      )}
    </section>
  );
}
