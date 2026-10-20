// Телефон заявителя по маске настоящего АРМ 112: «+7 (___) ___-__-__» (снимки
// docs/screenshots/card_112, инструкция п. 4.1). В поле — номер по маске, на сервер —
// «+7» и десять цифр (contracts/card.schema.json).

/** Десять цифр после +7: «8» или «7» перед полным номером — код страны, его отбрасываем. */
export function phoneDigits(text: string): string {
  const digits = text.trim().replace(/^\+7/, "").replace(/\D/g, "");
  const national =
    digits.length > 10 && /^[78]/.test(digits) ? digits.slice(1) : digits;
  return national.slice(0, 10);
}

/** Значение поля по маске; без цифр — пустое, тогда видна серая маска-подсказка. */
export function maskPhone(text: string): string {
  const digits = phoneDigits(text);
  if (!digits) return "";
  let masked = `+7 (${digits.slice(0, 3)}`;
  if (digits.length > 3) masked += `) ${digits.slice(3, 6)}`;
  if (digits.length > 6) masked += `-${digits.slice(6, 8)}`;
  if (digits.length > 8) masked += `-${digits.slice(8, 10)}`;
  return masked;
}

/** Номер начат, но не дописан: такой номер не сохраняется. */
export function phoneIncomplete(text: string): boolean {
  const length = phoneDigits(text).length;
  return length > 0 && length < 10;
}

/** Для сохранения: «+7» и десять цифр, пустая строка или неполный номер как есть. */
export function phoneValue(text: string): string {
  const digits = phoneDigits(text);
  if (digits.length === 10) return `+7${digits}`;
  return digits ? text : "";
}
