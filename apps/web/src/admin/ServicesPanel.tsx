// Справочник служб ДДС (C-07, NFR-12): кому адресуются карточки и куда звонит софтфон.
// Администратор включает и выключает службу — PUT /services/{id}; справочник не удаляется.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../shared/api";
import type { components } from "../api-client/schema";
import kit from "../teacher/console/Console.module.css";
import styles from "./Admin.module.css";

type Service = components["schemas"]["Service"];

export function ServicesPanel() {
  const queries = useQueryClient();
  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const { data, error } = await api.GET("/services");
      if (!data) throw new Error(error?.message ?? "Службы недоступны.");
      return data;
    },
  });
  const [confirm, setConfirm] = useState<Service | null>(null);
  const [notice, setNotice] = useState("");
  const toggle = useMutation({
    mutationFn: async (service: Service) => {
      const { data, error } = await api.PUT("/services/{id}", {
        params: {
          header: { "X-CSRF-Token": csrfToken() },
          path: { id: service.id },
        },
        body: { is_active: !service.is_active },
      });
      if (!data) throw new Error(error?.message ?? "Не сохранено.");
      return data;
    },
    onSuccess: async (service) => {
      setConfirm(null);
      setNotice(
        service.is_active
          ? `${service.name} снова доступна: в неё можно звонить, её можно выбрать в новых занятиях и пакетах.`
          : `${service.name} выключена.`,
      );
      await queries.invalidateQueries({ queryKey: ["services"] });
    },
  });

  if (services.isPending)
    return <p className={kit.placeholder}>Загружаем службы…</p>;
  if (!services.data)
    return (
      <p role="alert" className={kit.placeholder}>
        Службы недоступны.
      </p>
    );

  const active = services.data.filter((service) => service.is_active).length;
  const ask = (service: Service) => {
    setNotice("");
    toggle.reset();
    if (service.is_active) setConfirm(service);
    else toggle.mutate(service);
  };
  return (
    <div className={kit.tabBody}>
      {notice && (
        <p role="status" className={kit.message}>
          {notice}
        </p>
      )}
      {!confirm && toggle.isError && (
        <p role="alert" className={kit.warning}>
          {toggle.error.message}
        </p>
      )}
      {confirm && (
        <div
          className={kit.panel}
          role="region"
          aria-label={`Выключить: ${confirm.name}`}
        >
          <h3 className={kit.panelTitle}>Выключить: {confirm.name}</h3>
          <p className={kit.warning}>
            В службу нельзя будет позвонить (добавочный {confirm.phone_ext}) и
            перенаправить в неё карточку, её не будет в новых занятиях и
            пакетах. Сценарии и история сохраняются, включить службу можно в
            любой момент. Пока служба участвует в идущем занятии, выключить её
            нельзя.
          </p>
          {toggle.isError && <p role="alert">{toggle.error.message}</p>}
          <div className={kit.actions}>
            <button
              type="button"
              className={kit.primary}
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(confirm)}
            >
              Да, выключить
            </button>
            <button
              type="button"
              className={kit.plain}
              onClick={() => {
                setConfirm(null);
                toggle.reset();
              }}
            >
              Отмена
            </button>
          </div>
        </div>
      )}
      <div className={kit.panel}>
        <h3 className={kit.panelTitle}>
          Службы ДДС · {active} из {services.data.length} включены
        </h3>
        <p className={kit.hint}>
          Обучаемый набирает добавочный номер в учебном телефоне. Голос
          определяет, кто отвечает на звонок.
        </p>
        <div className={styles.wide}>
          <table className={kit.table}>
            <thead>
              <tr>
                <th>Служба</th>
                <th>Код</th>
                <th>Категория</th>
                <th>Добавочный</th>
                <th>Голос</th>
                <th>Состояние</th>
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>
              {services.data.map((service) => (
                <tr key={service.id}>
                  <td>
                    <strong>{service.name}</strong>
                  </td>
                  <td>
                    <code>{service.code}</code>
                  </td>
                  <td>{service.category}</td>
                  <td className={kit.seat}>{service.phone_ext}</td>
                  <td>{service.voice_profile}</td>
                  <td>
                    <span
                      className={service.is_active ? styles.on : styles.off}
                    >
                      {service.is_active ? "включена" : "выключена"}
                    </span>
                  </td>
                  <td className={kit.rowActions}>
                    <button
                      type="button"
                      className={kit.plain}
                      aria-label={`${service.is_active ? "Выключить" : "Включить"}: ${service.name}`}
                      disabled={toggle.isPending}
                      onClick={() => ask(service)}
                    >
                      {service.is_active ? "Выключить" : "Включить"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
