// Публичная точка входа софтфона. Внутренние модули наружу не выставляем:
// Qwots монтирует <Softphone /> в телефонную полосу шапки карточки.
export { Softphone, type SoftphoneProps } from "./Softphone";
export { useSoftphone, type SoftphoneView } from "./useSoftphone";
export type { CallState, SoftphoneModel } from "./machine";
