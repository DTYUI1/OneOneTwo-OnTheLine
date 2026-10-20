// Справочник служб (data/phonebook.json): службы ДДС и Система-112. Система-112 — адресат
// звонка в «Справочнике», а не служба ДДС: место, учётную запись и сценарий на неё не
// назначают (GP-04, contracts/data_formats.md).
export const SYSTEM_112_CATEGORY = "system112";

export const isDdsService = (service: { readonly category: string }): boolean =>
  service.category !== SYSTEM_112_CATEGORY;

/**
 * Подпись службы в интерфейсе — её название из справочника («ЖКХ», «Служба 101»).
 * Идентификатор службы (`GKH`, `MOSLIFT`) латиницей и обучаемому, и преподавателю не
 * показываем: интерфейс русский (`CONTRIBUTING.md`, `qa/e2e/russian-ui.spec.ts`).
 * Справочник ещё не загружен — подписи нет.
 */
export const serviceLabel = (
  services:
    | readonly { readonly id: string; readonly name: string }[]
    | undefined,
  id: string | null | undefined,
): string =>
  (id ? services?.find((service) => service.id === id)?.name : "") ?? "";

/**
 * Короткая подпись службы в тексте карточки: цифровая ДДС — своим номером («101»), как в
 * АРМ-112, остальные — названием («ЖКХ»), чтобы латиница идентификатора не попадала на
 * экран. Справочник ещё не загружен — остаётся идентификатор.
 */
export const serviceShort = (
  services:
    | readonly { readonly id: string; readonly name: string }[]
    | undefined,
  id: string,
): string => (/^\d+$/.test(id) ? id : serviceLabel(services, id) || id);
