// Публичная точка входа реплея. Пульт преподавателя (зона Qwots) монтирует
// <Replay cardId={...} />; внутренние модули наружу не выставляем.
export { Replay, type ReplayProps } from "./Replay";
export { useReplay, type ReplayView } from "./useReplay";
export type { Moment, Timeline } from "./timeline";
