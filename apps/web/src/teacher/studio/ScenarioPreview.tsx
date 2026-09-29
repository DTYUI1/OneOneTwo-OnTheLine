// Предпросмотр: карточка глазами обучаемого (в палитре АРМ) и эталон словами —
// что оценщик будет ждать от диспетчера.
import {
  COMPLICATION_LABELS,
  expectedActions,
  type ScenarioForm,
} from "./studioModel";
import styles from "./Studio.module.css";

export function ScenarioPreview({
  form,
  serviceName,
}: {
  form: ScenarioForm;
  serviceName: (id: string) => string;
}) {
  const address = [
    form.address.street,
    form.address.house && `д. ${form.address.house}`,
    form.address.building && `корп. ${form.address.building}`,
    form.address.apartment && `кв. ${form.address.apartment}`,
  ]
    .filter(Boolean)
    .join(", ");
  const steps = expectedActions(form, serviceName);

  return (
    <div className={styles.preview}>
      <h3 className={styles.previewTitle}>Так увидит обучаемый</h3>
      <div className={styles.card} aria-label="Предпросмотр карточки">
        <div className={styles.cardHead}>
          <div className={styles.phone}>
            <span>АОН</span>
            <strong>{form.phoneAon || "—"}</strong>
          </div>
          <div className={styles.cardNumber}>
            Происшествие {form.number || "—"}
          </div>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.cardField}>
            <span>ФИО заявителя</span>
            {form.callerName || "—"}
          </div>
          <div className={styles.cardField}>
            <strong>
              {form.address.city}
              {form.address.okrug && `, (${form.address.okrug}`}
              {form.address.district && `, ${form.address.district}`}
              {form.address.okrug && ")"}
            </strong>
            {address || "адрес не указан"}
          </div>
          <div className={styles.cardText}>
            {form.description || "Текст вызова пока пуст."}
          </div>
          <div className={styles.cardFlags}>
            Пострадавшие: {form.victims ? "да" : "нет"} · Отказ от скорой:{" "}
            {form.ambulanceRefused ? "да" : "нет"} · Заблокированные:{" "}
            {form.blockedPeople ? "да" : "нет"}
            {form.emergency && " · ЧС"}
          </div>
          <div className={styles.cardBar}>
            Происшествие {serviceName(form.targetServiceId) || "—"}
          </div>
          <div className={styles.cardField}>
            Класс: <strong>{form.incidentClass || "—"}</strong>
          </div>
        </div>
      </div>

      <h3 className={styles.previewTitle}>Эталон: что ждёт оценщик</h3>
      {steps.length === 0 ? (
        <p className={styles.muted}>Заполните эталон — здесь появятся шаги.</p>
      ) : (
        <ol className={styles.steps}>
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {form.complications.length > 0 && (
        <p className={styles.muted}>
          Осложнения:{" "}
          {form.complications
            .map((item) => COMPLICATION_LABELS[item])
            .join(", ")}
          .
        </p>
      )}
    </div>
  );
}
