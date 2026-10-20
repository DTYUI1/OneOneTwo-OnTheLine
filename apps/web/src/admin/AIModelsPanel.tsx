// Модели ИИ (HQ-016): какая модель проверяет комментарии и генерирует сценарии, на
// процессоре или видеокарте. GET /admin/ai-models, выбор — PUT /admin/ai-models/active:
// роутер llama.cpp загружает модель без перезапуска стенда.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../shared/api";
import {
  MODE_LABELS,
  activeLabel,
  gpuLabel,
  gpuReminder,
  compatibilityHint,
  gpuTarget,
  installHint,
  machineLabel,
  sizeLabel,
  type AIModels,
  type Mode,
} from "./aiModelsModel";
import kit from "../teacher/console/Console.module.css";
import styles from "./Admin.module.css";

export function useAIModels() {
  return useQuery({
    queryKey: ["ai-models"],
    queryFn: async () => {
      const { data, error } = await api.GET("/admin/ai-models");
      if (!data)
        throw new Error(error?.message ?? "Сведения о моделях недоступны.");
      return data;
    },
    // Пока модель загружается, опрашиваем чаще: администратор ждёт «работает».
    refetchInterval: (query) =>
      query.state.data?.active.status === "loading" ? 3_000 : 15_000,
  });
}

/** «Не напоминать» о видеокарте — одна настройка на систему (PUT /admin/ai-models/gpu-notice). */
export function useGpuNotice() {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (dismissed: boolean) => {
      const { data, error } = await api.PUT("/admin/ai-models/gpu-notice", {
        params: { header: { "X-CSRF-Token": csrfToken() } },
        body: { dismissed },
      });
      if (!data) throw new Error(error?.message ?? "Не сохранено.");
      return data;
    },
    onSuccess: (data: AIModels) => queries.setQueryData(["ai-models"], data),
  });
}

export function AIModelsPanel() {
  const queries = useQueryClient();
  const models = useAIModels();
  const notice = useGpuNotice();
  const choose = useMutation({
    mutationFn: async (choice: {
      model: string;
      mode: Mode;
      force?: boolean;
    }) => {
      const { data, error } = await api.PUT("/admin/ai-models/active", {
        params: { header: { "X-CSRF-Token": csrfToken() } },
        body: { ...choice, force: choice.force ?? false },
      });
      if (!data) throw new Error(error?.message ?? "Модель не переключена.");
      return data;
    },
    onSuccess: (data: AIModels) => queries.setQueryData(["ai-models"], data),
  });

  if (models.isPending)
    return <p className={kit.placeholder}>Проверяем состояние ИИ…</p>;
  if (!models.data)
    return (
      <p role="alert" className={kit.placeholder}>
        Сведения о моделях недоступны.
      </p>
    );

  const data = models.data;
  const cpuBenchmarks = data.benchmarks.filter((row) => row.mode === "cpu");
  const gpu = gpuLabel(data.hardware, data.notice_dismissed);
  const target = data.gpu_suggestion ? gpuTarget(data) : null;
  return (
    <div className={kit.tabBody}>
      {!data.ai_enabled && (
        <p className={kit.warning} role="status">
          ИИ на этом стенде выключен (запуск без --ai local): модели не
          используются. Выбор сохранится и заработает, когда ИИ включат.
        </p>
      )}
      <div
        className={`${styles.healthGrid} ${styles.modelHardware}`}
        aria-label="Модель и оборудование"
      >
        <div className={styles.tile_ok}>
          <span className={styles.tileLabel}>Сейчас работает</span>
          <strong className={styles.tileValue}>{activeLabel(data)}</strong>
          <span className={styles.tileHint}>
            Генерация сценариев и ИИ-проверка комментариев.
          </span>
        </div>
        <div className={styles.tile_neutral}>
          <span className={styles.tileLabel}>Процессор</span>
          <strong className={styles.tileValue}>
            {machineLabel(data.hardware)}
          </strong>
          <span className={styles.tileHint}>Режим по умолчанию.</span>
        </div>
        <div className={styles[`tile_${gpu.tone}`]}>
          <span className={styles.tileLabel}>Видеокарта</span>
          <strong className={styles.tileValue}>{gpu.value}</strong>
          <span className={styles.tileHint}>{gpu.hint}</span>
        </div>
      </div>

      <div className={styles.modelNotice}>
        <p className={kit.hint} role="status">
          {gpuReminder(data)}
        </p>
        <div className={kit.actions}>
          <button
            type="button"
            className={kit.plain}
            disabled={!target || choose.isPending}
            onClick={() =>
              target && choose.mutate({ model: target.id, mode: "gpu" })
            }
          >
            Использовать видеокарту
          </button>
          <button
            type="button"
            className={kit.plain}
            disabled={notice.isPending}
            onClick={() => notice.mutate(!data.notice_dismissed)}
          >
            {data.notice_dismissed ? "Снова напоминать" : "Скрыть напоминание"}
          </button>
        </div>
        <p role="alert" className={kit.hint}>
          {choose.error?.message ?? notice.error?.message ?? ""}
        </p>
      </div>
      <div className={kit.panel}>
        <h3 className={kit.panelTitle}>Модели</h3>
        <p className={kit.hint}>
          Переключение без перезапуска: модель загружается за десятки секунд,
          прежняя выгружается. Ставить модели — по желанию: файлы большие.
        </p>
        <div className={styles.wide}>
          <table className={kit.table}>
            <thead>
              <tr>
                <th>Модель</th>
                <th>Файл</th>
                <th>Требования</th>
                <th>Режим</th>
              </tr>
            </thead>
            <tbody>
              {data.models.map((model) => (
                <tr
                  key={model.id}
                  className={
                    data.active.model === model.id
                      ? styles.activeModel
                      : undefined
                  }
                >
                  <td>
                    <strong>{model.title}</strong>
                    <p className={kit.hint}>{model.summary}</p>
                    <p className={kit.hint}>
                      <strong>Когда выбирать:</strong> {model.choose_when}
                    </p>
                    <ul
                      className={kit.hint}
                      aria-label={`Плюсы: ${model.title}`}
                    >
                      {model.pros.map((item) => (
                        <li key={item}>+ {item}</li>
                      ))}
                    </ul>
                    <ul
                      className={kit.hint}
                      aria-label={`Минусы: ${model.title}`}
                    >
                      {model.cons.map((item) => (
                        <li key={item}>− {item}</li>
                      ))}
                    </ul>
                  </td>
                  <td>
                    {sizeLabel(model.size_bytes)}
                    <br />
                    <span className={model.installed ? styles.on : styles.off}>
                      {model.installed ? "установлена" : "не установлена"}
                    </span>
                    {!model.installed && (
                      <p className={kit.hint}>{installHint(model)}</p>
                    )}
                  </td>
                  <td>
                    {compatibilityHint(model, data.hardware) && (
                      <p className={kit.hint}>
                        <strong>
                          {compatibilityHint(model, data.hardware)}
                        </strong>
                      </p>
                    )}
                    Память от {model.ram_gb} ГБ
                    <br />
                    Видеокарта от {model.vram_gb} ГБ
                  </td>
                  <td>
                    <div className={styles.modelModes}>
                      {model.modes.map((mode) => {
                        const current =
                          data.active.model === model.id &&
                          data.active.mode === mode.mode;
                        return (
                          <div key={mode.mode}>
                            <button
                              type="button"
                              className={current ? kit.primary : kit.plain}
                              aria-pressed={current}
                              disabled={
                                current || !mode.available || choose.isPending
                              }
                              onClick={() =>
                                choose.mutate({
                                  model: model.id,
                                  mode: mode.mode,
                                })
                              }
                            >
                              {MODE_LABELS[mode.mode]}
                              {current ? " · работает" : ""}
                            </button>
                            {mode.reason && (
                              <p className={kit.hint}>{mode.reason}</p>
                            )}
                            {!mode.available && mode.can_force && !current && (
                              <button
                                type="button"
                                className={kit.plain}
                                disabled={choose.isPending}
                                onClick={() =>
                                  choose.mutate({
                                    model: model.id,
                                    mode: mode.mode,
                                    force: true,
                                  })
                                }
                              >
                                Всё равно использовать видеокарту
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className={kit.panel}>
        <h3 className={kit.panelTitle}>На этом компьютере</h3>
        <p className={kit.hint}>
          Генерация за последние 24 часа:{" "}
          {data.local_generation.mean_seconds === null
            ? "ещё не замерено"
            : `в среднем ${data.local_generation.mean_seconds.toLocaleString("ru-RU")} с на попытку (${data.local_generation.attempts}).`}{" "}
          По сохранённым сценариям; учитываются повторные попытки. Длительность
          ИИ-проверки пока не записывается.
        </p>
      </div>
      {cpuBenchmarks.length > 0 && (
        <div className={kit.panel}>
          <h3 className={kit.panelTitle}>
            Замеры команды на эталонных машинах
          </h3>
          <div className={styles.wide}>
            <table className={kit.table}>
              <thead>
                <tr>
                  <th>Модель</th>
                  <th>Режим</th>
                  <th>Компьютер</th>
                  <th>Сценарий</th>
                  <th>Проверка комментария</th>
                  <th>Печать ответа</th>
                  <th>Память</th>
                </tr>
              </thead>
              <tbody>
                {cpuBenchmarks.map((row) => (
                  <tr key={`${row.model}-${row.mode}-${row.machine}`}>
                    <td>
                      {data.models.find((model) => model.id === row.model)
                        ?.title ?? row.model}
                    </td>
                    <td>{MODE_LABELS[row.mode]}</td>
                    <td>{row.machine}</td>
                    <td>
                      {row.generate_seconds ? `${row.generate_seconds} с` : "—"}
                    </td>
                    <td>
                      {row.judge_seconds ? `${row.judge_seconds} с` : "—"}
                    </td>
                    <td>
                      {row.tokens_per_second
                        ? `${row.tokens_per_second} токенов/с`
                        : "—"}
                    </td>
                    <td>{row.memory_gb ? `${row.memory_gb} ГБ` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
