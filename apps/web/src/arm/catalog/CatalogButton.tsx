// «Каталог сценариев» (17.10): все проработанные сценарии — с событиями и ветками — по
// службам, своя служба первой. «Пройти» сразу запускает тренировку с этим сценарием:
// обучаемый — диспетчер службы сценария, без подсказчика. Подбор сценариев на занятие
// делает преподаватель; каталог — для самостоятельной работы.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api-client/schema";
import { api } from "../../shared/api";
import { Dialog } from "../Dialog";
import { PracticeButton } from "../practice/PracticeButton";
import { groupByService, trainsText } from "./catalogModel";
import arm from "../ArmPage.module.css";
import progress from "../progress/Progress.module.css";
import styles from "./Catalog.module.css";

type User = components["schemas"]["User"];

export function CatalogButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={arm.resultsButton}
        data-help="tool-catalog"
        onClick={() => setOpen(true)}
        title="Все проработанные сценарии: выбрать и пройти самому"
      >
        Каталог сценариев
      </button>
      {open && <CatalogDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function CatalogDialog({ onClose }: { onClose: () => void }) {
  // Пользователь уже загружен оболочкой (Shell): своя служба — из него.
  const me = useQueryClient().getQueryData<User | null>(["me"]);
  const catalog = useQuery({
    queryKey: ["practice-catalog"],
    queryFn: async () => {
      const { data, error } = await api.GET("/practice/catalog");
      if (!data) throw new Error(error?.message ?? "Каталог недоступен.");
      return data;
    },
  });
  const groups = catalog.data
    ? groupByService(catalog.data, me?.dds_service_id ?? null)
    : [];
  return (
    <div className={progress.backdrop}>
      <Dialog
        label="Каталог сценариев"
        className={progress.dialog}
        onClose={onClose}
      >
        <h2>Каталог сценариев</h2>
        {catalog.isPending && <p className={progress.note}>Загружаем…</p>}
        {catalog.isError && (
          <p role="alert" className={progress.note}>
            {catalog.error.message}
          </p>
        )}
        {catalog.data?.length === 0 && (
          <p className={progress.note}>Проработанных сценариев пока нет.</p>
        )}
        {groups.map((group) => (
          <section
            key={group.serviceId}
            className={styles.group}
            aria-label={group.serviceName}
          >
            <h3>
              {group.serviceName}
              {group.own ? " — ваша служба" : ""}
            </h3>
            <ul className={progress.steps}>
              {group.items.map((item) => {
                const trains = trainsText(item.trains);
                return (
                  <li key={item.id} className={progress.step}>
                    <div className={progress.stepHead}>
                      <strong>{item.title}</strong>
                      <span className={progress.chip}>
                        уровень {item.level}
                      </span>
                    </div>
                    <p>{item.description}</p>
                    {trains && (
                      <p className={progress.muted}>Тренирует: {trains}.</p>
                    )}
                    <PracticeButton
                      scenario={item.id}
                      label="Пройти"
                      title={`Тренировка «${item.title}»: вы — диспетчер службы «${item.service_name}»`}
                      className=""
                      onStarted={onClose}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        <p className={progress.note}>
          В тренировке по каталогу вы — диспетчер службы сценария. Подсказчика
          нет, оценка — как на занятии.
        </p>
        <div className={progress.actions}>
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </Dialog>
    </div>
  );
}
