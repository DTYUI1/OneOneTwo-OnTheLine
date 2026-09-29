// Сообщения об ошибках — GET /problem-reports (28.09). Их отправляют обучаемые,
// преподаватели и администраторы кнопкой «Сообщить об ошибке» в шапке.
import { useQuery } from "@tanstack/react-query";
import { api } from "../shared/api";
import { REPORT_CATEGORIES } from "../shared/ReportButton";
import { ROLE_LABELS, screenName } from "./adminModel";
import kit from "../teacher/console/Console.module.css";
import styles from "./Admin.module.css";

const when = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

export function ProblemReportsPanel() {
  const reports = useQuery({
    queryKey: ["problem-reports"],
    // Сообщения приходят во время занятия — список обновляется сам.
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await api.GET("/problem-reports");
      if (!data) throw new Error(error?.message ?? "Сообщения недоступны.");
      return data;
    },
  });

  if (reports.isPending)
    return <p className={kit.placeholder}>Загружаем сообщения…</p>;
  if (!reports.data)
    return (
      <p role="alert" className={kit.placeholder}>
        Сообщения недоступны.
      </p>
    );

  return (
    <div className={kit.tabBody}>
      <div className={kit.panel}>
        <h3 className={kit.panelTitle}>
          Сообщения об ошибках · {reports.data.length}
        </h3>
        <p className={kit.hint}>
          Свежие сверху. Сообщение отправляют кнопкой «Сообщить об ошибке» в
          шапке — экран подставляется сам.
        </p>
        {reports.data.length === 0 ? (
          <p className={kit.placeholder}>Сообщений пока нет.</p>
        ) : (
          <div className={styles.wide}>
            <table className={kit.table}>
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>Автор</th>
                  <th>Роль</th>
                  <th>Что случилось</th>
                  <th>Экран</th>
                  <th>Описание</th>
                </tr>
              </thead>
              <tbody>
                {reports.data.map((report) => (
                  <tr key={report.id}>
                    <td>{when.format(new Date(report.created_at))}</td>
                    <td>{report.author_name}</td>
                    <td>{ROLE_LABELS[report.author_role]}</td>
                    <td>{REPORT_CATEGORIES[report.category]}</td>
                    <td>{screenName(report.page)}</td>
                    <td className={styles.reportText}>{report.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
