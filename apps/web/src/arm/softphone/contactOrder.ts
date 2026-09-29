// Порядок номеров в справочнике телефона. Проводник велит звонить своей службе —
// она стоит первой; за ней остальные службы карточки, потом прочие. Внутри
// группы — по номеру, как раньше, чтобы место номера не прыгало между карточками.

export interface Contact {
  readonly id: string;
  readonly phone_ext: string;
}

export function orderContacts<T extends Contact>(
  contacts: readonly T[],
  ownServiceId: string | null | undefined,
  cardServiceIds: readonly string[],
): T[] {
  const card = new Set(cardServiceIds);
  const group = (contact: T) =>
    ownServiceId && contact.id === ownServiceId
      ? 0
      : card.has(contact.id)
        ? 1
        : 2;
  return [...contacts].sort(
    (left, right) =>
      group(left) - group(right) ||
      left.phone_ext.localeCompare(right.phone_ext),
  );
}
