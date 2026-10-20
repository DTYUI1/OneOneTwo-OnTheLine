// Модуль «Оператор 112» выключен по умолчанию (созвон 16.10); включает администратор на стенде.
// Стенд с включённым модулем прогоняется с E2E_OPERATOR_MODULE=1 — тогда e2e оператора идут.
export const OPERATOR_MODULE = ["1", "true"].includes(
  process.env.E2E_OPERATOR_MODULE ?? "",
);
export const OPERATOR_OFF_REASON =
  "модуль «Оператор 112» выключен (docs/decisions.md); E2E_OPERATOR_MODULE=1 для стенда с включённым модулем";

// Приветствие обучаемого после входа (WelcomeGate): с модулем 112 — «Выберите обучение» и плитка
// «Диспетчер служб», без него (GP-13) — «Добро пожаловать» и «Перейти в тренажёр».
export const TRAINEE_GREETING = OPERATOR_MODULE
  ? "Выберите обучение"
  : "Добро пожаловать";
export const TRAINEE_BEGIN = OPERATOR_MODULE
  ? "Диспетчер служб"
  : "Перейти в тренажёр";
