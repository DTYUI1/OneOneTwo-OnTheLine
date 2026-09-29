// Публичная точка входа live-доски. Пульт преподавателя (зона Qwots)
// монтирует <LiveBoard /> у себя; внутренние модули наружу не выставляем.
export { LiveBoard } from "./LiveBoard";
export { useLiveBoard, type LiveBoardView } from "./useLiveBoard";
export type { BoardTile } from "./board";
