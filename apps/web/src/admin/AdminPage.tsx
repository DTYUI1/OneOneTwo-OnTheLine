// Администрирование (T-016) в том же языке, что пульт преподавателя: светлая
// шапка, стальная колонка разделов, тёмная полоса заголовка раздела.
import { useState } from "react";
import { AuditPanel } from "./AuditPanel";
import { BackupsPanel } from "./BackupsPanel";
import { adminWarnings } from "./adminModel";
import { useSystemStatus } from "./useSystemStatus";
import { HealthPanel } from "./HealthPanel";
import { ProblemReportsPanel } from "./ProblemReportsPanel";
import { ServicesPanel } from "./ServicesPanel";
import { SettingsForm } from "./SettingsForm";
import { UsersPanel } from "./UsersPanel";
import page from "../teacher/TeacherPage.module.css";
import kit from "../teacher/console/Console.module.css";
import { useHelpGuide } from "../shared/help/HelpProvider";
import { ADMIN_GUIDE } from "./help/topics";

type Section =
  | "health"
  | "settings"
  | "users"
  | "backups"
  | "services"
  | "audit"
  | "reports";

const SECTIONS: { key: Section; title: string; lead: string }[] = [
  {
    key: "health",
    title: "Состояние системы",
    lead: "Компоненты, нагрузка, место и резервные копии — перед занятием смотреть сюда.",
  },
  {
    key: "settings",
    title: "Нормативы и оценка",
    lead: "Нормативы времени, нагрузка и веса критериев для новых занятий.",
  },
  {
    key: "users",
    title: "Пользователи",
    lead: "Учётные записи класса: обучаемые, преподаватели, администраторы.",
  },
  {
    key: "backups",
    title: "Копии и корзина",
    lead: "Резервная копия по кнопке и удалённые учётные записи до их обезличивания.",
  },
  {
    key: "services",
    title: "Службы ДДС",
    lead: "Справочник служб, которым адресуются карточки.",
  },
  {
    key: "audit",
    title: "Журнал аудита",
    lead: "Кто, что и когда сделал в системе — для проверки безопасности.",
  },
  {
    key: "reports",
    title: "Сообщения об ошибках",
    lead: "Что пользователи сообщили кнопкой «Сообщить об ошибке» в шапке.",
  },
];

export function AdminPage() {
  const [section, setSection] = useState<Section>("health");
  const current = SECTIONS.find((item) => item.key === section) ?? SECTIONS[0];
  // Предупреждения (копии, диск, очередь, нагрузка) — на любой странице администрирования;
  // сбои базы, обработчика и канала обновлений показывает общая шапка.
  const status = useSystemStatus();
  const warnings = status.data ? adminWarnings(status.data) : [];
  useHelpGuide(ADMIN_GUIDE);

  return (
    <main className={page.page}>
      <header className={page.top}>
        <h1>Администрирование</h1>
        <p className={page.summary}>{current.lead}</p>
      </header>
      <div className={page.layout}>
        <nav
          className={kit.side}
          aria-label="Разделы администрирования"
          data-help="admin-sections"
        >
          <h2 className={kit.sideTitle}>Разделы</h2>
          {SECTIONS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={kit.sideLink}
              aria-pressed={item.key === section}
              onClick={() => {
                setSection(item.key);
                window.scrollTo({ top: 0 });
              }}
            >
              {item.title}
            </button>
          ))}
        </nav>
        <div className={page.content}>
          {warnings.length > 0 && section !== "health" && (
            <div className={kit.warning} role="status">
              {warnings.join(" ")}{" "}
              <button
                type="button"
                className={kit.plain}
                onClick={() => setSection("health")}
              >
                Состояние системы
              </button>
            </div>
          )}
          <section
            className={kit.view}
            aria-labelledby="admin-section"
            data-help={`admin-${section}`}
          >
            <header className={kit.titleBar}>
              <div>
                <h2 id="admin-section">{current.title}</h2>
              </div>
            </header>
            {section === "health" && <HealthPanel />}
            {section === "settings" && <SettingsForm />}
            {section === "users" && (
              <UsersPanel onTrash={() => setSection("backups")} />
            )}
            {section === "backups" && <BackupsPanel />}
            {section === "services" && <ServicesPanel />}
            {section === "audit" && <AuditPanel />}
            {section === "reports" && <ProblemReportsPanel />}
          </section>
        </div>
      </div>
    </main>
  );
}
