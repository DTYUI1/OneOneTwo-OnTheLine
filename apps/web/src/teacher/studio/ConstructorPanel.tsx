// Конструктор C-05 (D-01, п. 1): сервер собирает сценарий по классификатору 046_24
// из выбора преподавателя и seed. Ничего не сохраняется — форма лишь заполняется
// предложением сервера, дальше преподаватель правит и сохраняет как обычно.
import { useState } from "react";
import { ConfirmDialog } from "../../arm/ConfirmDialog";
import { api, csrfToken } from "../../shared/api";
import { randomSeed } from "./packModel";
import { provenanceLines } from "./provenanceModel";
import {
  constructorFromForm,
  formFromPreview,
  type ScenarioForm,
  type ScenarioPreviewResult,
} from "./studioModel";
import kit from "../console/Console.module.css";

export function ConstructorPanel({
  form,
  disabled,
  onApply,
}: {
  form: ScenarioForm;
  disabled: boolean;
  onApply: (next: ScenarioForm) => void;
}) {
  const [seed, setSeed] = useState(randomSeed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ScenarioPreviewResult | null>(null);
  // Форма уже заполнена: замену спрашиваем окном, а не системным confirm.
  const [asking, setAsking] = useState(false);

  const missing = !form.incidentTypeCode || !form.targetServiceId;
  // Конструктор требует адрес: без города, улицы и дома сервер отвечает 422.
  const noAddress =
    !form.address.city.trim() ||
    !form.address.street.trim() ||
    !form.address.house.trim();

  const build = async () => {
    setAsking(false);
    setBusy(true);
    setError("");
    const { data, error: failure } = await api.POST("/scenarios/preview", {
      params: { header: { "X-CSRF-Token": csrfToken() } },
      body: { constructor: constructorFromForm(form, seed) },
    });
    setBusy(false);
    if (!data) {
      setResult(null);
      return setError(failure?.message ?? "Конструктор не ответил.");
    }
    setResult(data);
    onApply(formFromPreview(form, data));
  };

  const source = result
    ? provenanceLines({
        scenario_id: result.scenario.id,
        version: result.scenario.version,
        provenance: result.provenance,
        training_plan: result.training_plan,
      }).slice(0, 2)
    : [];

  return (
    <div aria-label="Конструктор по классификатору">
      <div className={kit.actions}>
        <label className={kit.field}>
          Исходное число
          <input
            type="number"
            value={seed}
            className={kit.number}
            disabled={disabled || busy}
            onChange={(event) => setSeed(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          className={kit.plain}
          disabled={disabled || busy || missing || noAddress}
          onClick={() =>
            form.description.trim() !== "" ? setAsking(true) : void build()
          }
        >
          {busy ? "Собираем…" : "Собрать по классификатору"}
        </button>
      </div>
      {asking && (
        <ConfirmDialog
          title="Заменить карточку?"
          confirmLabel="Заменить"
          onConfirm={build}
          onCancel={() => setAsking(false)}
        >
          Карточка и эталон будут заменены сценарием от конструктора.
        </ConfirmDialog>
      )}
      <p className={kit.hint}>
        {missing
          ? "Выберите тип и службу — конструктор соберёт карточку и эталон по классификатору."
          : noAddress
            ? "Заполните «Адрес происшествия» ниже (город, улица, дом) — по нему конструктор соберёт сценарий."
            : "Сервер соберёт карточку и эталон по типу, службе, адресу, пострадавшим и осложнениям. То же исходное число — тот же сценарий. Сохраните результат кнопкой «Сохранить черновик»."}
      </p>
      {error && (
        <p className={kit.problems} role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className={kit.note} role="status">
          Заполнено конструктором (исходное число {seed}).{" "}
          {source.map((line) => `${line.label}: ${line.value}.`).join(" ")}
          {result.suggested_weight !== form.weight && (
            <>
              {" "}
              Сервер оценивает вес в {result.suggested_weight}.{" "}
              <button
                type="button"
                className={kit.plain}
                disabled={disabled}
                onClick={() =>
                  onApply({ ...form, weight: result.suggested_weight })
                }
              >
                Взять вес {result.suggested_weight}
              </button>
            </>
          )}
          {result.validation_errors.length > 0 && (
            <ul className={kit.problems}>
              {result.validation_errors.map((item) => (
                <li key={`${item.path}:${item.code}`}>
                  {item.message} ({item.path})
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
