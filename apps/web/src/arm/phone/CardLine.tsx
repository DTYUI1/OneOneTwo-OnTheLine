// Разговор карточки без открытой карточки (HQ-033, решение 18.10): в финальной смене ответ на
// вызов бригады не открывает карточку — обучаемый находит её сам по номеру бригады. Разговор
// (доклад, ответы, «Как приняли?») ведёт тот же софтфон карточки, что внутри IncidentCard:
// он выводит связь порталами в окно телефона, поэтому ему не нужна видимая карточка. Открыта
// другая карточка — здесь только разговор (`callOnly`): контакты и табло сил окна телефона —
// её, звонок из контактов идёт по ней. Открыта эта же — своего софтфона у неё нет, связь вся
// здесь (без перезапуска посреди разговора).
import type { Card } from "../../shared/api";
import { Softphone } from "../softphone";
import { useParticipant } from "../useParticipant";

export function CardLine({
  card,
  callOnly,
  onCallShown,
}: {
  readonly card: Card;
  /** Открыта другая карточка: в окне телефона — только разговор этой. */
  readonly callOnly: boolean;
  readonly onCallShown: (shown: boolean) => void;
}) {
  const context = useParticipant(card.session_id, card.trainee_id);
  return (
    <Softphone
      key={card.id}
      cardId={card.id}
      disabled={!context.canAct}
      serviceIds={card.source.service_ids}
      ownServiceId={context.participant?.dds_service_id ?? null}
      cardState={card.state}
      callOnly={callOnly}
      onCallShown={onCallShown}
    />
  );
}
