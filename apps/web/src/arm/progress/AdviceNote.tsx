// Рекомендации к дальнейшему обучению (GP-14): что подтянуть и следующий шаг. Считает
// сервер по последним оценённым карточкам (GET /progress, advice); здесь только вывод.
// Под ними — как новая попытка выполнила прошлые рекомендации (TC-11).
import { adviceLines, previousLines, type Advice } from "./progressModel";

export function AdviceNote({
  advice,
  cardId,
  className,
}: {
  advice: Advice;
  /** Разбор карточки: отметку прошлых рекомендаций показываем только у неё. */
  cardId?: string;
  className?: string;
}) {
  const previous = previousLines(advice, cardId);
  return (
    <div className={className} aria-label="Рекомендации">
      <strong>Рекомендации</strong>
      <ul>
        {adviceLines(advice).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {previous.length > 0 && (
        <>
          <strong>Как выполнены прошлые рекомендации</strong>
          <ul>
            {previous.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
