/** Общий текст ошибки запроса: читаем поле и причину, сохраняя неизвестные пути. */
export function validationMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const details = (error as { details?: { errors?: unknown } }).details;
  if (!Array.isArray(details?.errors)) return null;
  const names: Record<string, string> = {
    level: "Уровень",
    weight: "Вес",
    title: "Название",
    name: "Название",
    target_service_id: "Служба",
    incident_type_code: "Тип происшествия",
    "card.description": "Описание происшествия",
    "card.caller_name": "ФИО заявителя",
    "card.number": "Номер карточки",
    "card.phone_aon": "Телефон заявителя",
    "card.address.street": "Улица",
    "card.address.house": "Дом",
    "reference.expected_flow": "Порядок статусов",
    "reference.expected_comment": "Образец комментария",
  };
  const lines = details.errors.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const raw = item as { field?: unknown; reason?: unknown };
    let field = typeof raw.field === "string" ? raw.field : "";
    let reason =
      typeof raw.reason === "string" ? raw.reason : "Проверьте значение.";
    const nested = reason.match(/Поле ([\w.]+):\s*(.*)/s);
    if (nested) {
      field = nested[1];
      reason = nested[2];
    }
    if (field.startsWith("reference.expected_call")) {
      if (field.endsWith("before_s"))
        return [
          "Звонок: укажите срок целым числом больше нуля или снимите галочку обязательного звонка.",
        ];
      return [
        "Звонок: укажите службу и её трёхзначный номер или снимите галочку обязательного звонка.",
      ];
    }
    if (field === "level") return ["Уровень: выберите целое число от 1 до 4."];
    if (field === "weight") return ["Вес: введите целое число от 1 до 10."];
    const name = names[field];
    if (name) {
      if (/required|Field required/i.test(reason)) reason = "Заполните поле.";
      else if (/greater than or equal to|minimum/i.test(reason))
        reason = `Увеличьте значение. ${reason}`;
      else if (/integer|int_parsing/i.test(reason))
        reason = "Введите целое число.";
    }
    return [`${name ?? (field || "Запрос")}: ${reason}`];
  });
  return lines.length ? lines.join("; ") : null;
}
