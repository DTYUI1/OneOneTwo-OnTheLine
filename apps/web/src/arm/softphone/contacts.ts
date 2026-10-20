// Абоненты телефона ДДС (GP-09, рекомендации организаторов 16.10, п. 8): руководство,
// аварийная бригада и, если преподаватель включил, заявитель. Список — settings.phone_contacts
// занятия по ДДС (contracts/scenario-events.md, «Телефон ДДС»); нет списка у ДДС — по умолчанию,
// как evalcore.defaults.DEFAULT_PHONE_CONTACTS. Номер вне списка не отвечает.
import type { components } from "../../api-client/schema";
import { formatPhone } from "../../shared/phone";

export type PhoneContact = components["schemas"]["PhoneContact"];
export type ContactRole = PhoneContact["role"];
type Service = components["schemas"]["Service"];

/** Не больше 10 номеров на одну ДДС (рекомендации 16.10, п. 8). */
export const CONTACTS_MAX = 10;

export const ROLE_LABELS: Record<ContactRole, string> = {
  head: "Руководитель организации",
  response_chief: "Начальник отдела реагирования",
  crew_chief: "Начальник аварийной бригады",
  crew_specialist: "Специалист аварийной бригады",
  caller: "Заявитель",
};

export const DEFAULT_CONTACTS: readonly PhoneContact[] = [
  { role: "head", name: ROLE_LABELS.head, number: "401" },
  { role: "response_chief", name: ROLE_LABELS.response_chief, number: "402" },
  { role: "crew_chief", name: ROLE_LABELS.crew_chief, number: "403" },
  { role: "crew_specialist", name: ROLE_LABELS.crew_specialist, number: "404" },
];

/** Условный номер: три цифры 400–999 — не совпадает с номерами служб и бригад. */
const NUMBER = /^[4-9][0-9]{2}$/;

/** Абоненты ДДС `serviceId` на занятии: список преподавателя или по умолчанию. */
export function contactsFor(
  settings:
    | { readonly phone_contacts?: Record<string, PhoneContact[]> }
    | null
    | undefined,
  serviceId: string | null,
): readonly PhoneContact[] {
  const configured = settings?.phone_contacts;
  if (configured && serviceId !== null && serviceId in configured)
    return configured[serviceId] ?? [];
  return DEFAULT_CONTACTS;
}

/** Что не так со списком абонентов одной ДДС — как проверит сервер (422). */
export function contactProblems(
  contacts: readonly PhoneContact[],
): readonly string[] {
  const problems: string[] = [];
  if (contacts.length > CONTACTS_MAX)
    problems.push(`Не больше ${CONTACTS_MAX} номеров на одну ДДС.`);
  if (contacts.some((item) => !item.name.trim()))
    problems.push("У каждого абонента должно быть имя.");
  if (contacts.some((item) => !NUMBER.test(item.number)))
    problems.push("Номер абонента — три цифры от 400 до 999.");
  const numbers = contacts.map((item) => item.number);
  if (new Set(numbers).size !== numbers.length)
    problems.push("Номера абонентов повторяются.");
  return problems;
}

/**
 * Набранный номер → номер для звонка. Службу набирают и городским номером справочника,
 * бригаду и руководство своей ДДС — полным условным (`virtualPhone`), заявителя — номером
 * из карточки (`+7…`, `8…` или 10 цифр): они переводятся в короткий номер. Номер карточки без заявителя в списке —
 * недоступен (`null`).
 */
export function dialNumber(
  input: string,
  contacts: readonly PhoneContact[],
  cardPhones: readonly string[],
  services: readonly Pick<Service, "phone_ext" | "phone">[] = [],
  ownExt: string | null = null,
): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 3) return digits;
  const tail = digits.slice(-10);
  const ext = tail.length === 10 ? virtualExt(tail, ownExt) : null;
  if (ext) return ext;
  const service = services.find(
    (item) =>
      tail.length === 10 && item.phone?.replace(/\D/g, "").slice(-10) === tail,
  );
  if (service) return service.phone_ext;
  const caller = contacts.find((item) => item.role === "caller");
  const own =
    tail.length === 10 &&
    cardPhones.some((phone) => phone.replace(/\D/g, "").slice(-10) === tail);
  return own && caller ? caller.number : null;
}

/**
 * Абоненты для набора в виде записей справочника: звонок им — как в службу (доклад,
 * «Слушаю вас»), сервер записывает его на свою ДДС. Голос — голос своей службы.
 */
export function contactServices(
  contacts: readonly PhoneContact[],
  own: Service | undefined,
): readonly Service[] {
  if (!own) return [];
  return contacts.map((item) => ({
    ...own,
    name: item.name,
    phone_ext: item.number,
    phone: null,
  }));
}

/**
 * Полный условный номер абонента ДДС (HQ-053): +7 (495) <служба>-0<короткий> — у бригад,
 * руководства и рабочих мест, как городские у служб. «+7 (495) 103-02-05» — бригада 205
 * службы 103; по нему же и набирают (`dialNumber`).
 */
export function virtualPhone(serviceExt: string, ext: string): string {
  return `+7495${serviceExt}0${ext.padStart(3, "0")}`;
}

/**
 * Короткий номер своей ДДС из полного условного — или `null`, если номер не её или это
 * рабочее место (`ownNumber`, короткий с нуля).
 */
function virtualExt(digits: string, serviceExt: string | null): string | null {
  const match = /^495(\d{3})0([1-9]\d{2})$/.exec(digits);
  return match && match[1] === serviceExt ? (match[2] ?? null) : null;
}

/**
 * Свой номер рабочего места (HQ-053): полный условный номер своей службы с номером
 * рабочего места вместо короткого. Без рабочего места — городской номер службы.
 */
export function ownNumber(
  service: Pick<Service, "phone_ext" | "phone"> | undefined,
  workstation: number | null | undefined,
): string | null {
  if (!service) return null;
  if (workstation)
    return formatPhone(virtualPhone(service.phone_ext, String(workstation)));
  return service.phone ? formatPhone(service.phone) : service.phone_ext;
}
