import type { components } from "../api-client/schema";

export type DemoAccounts = components["schemas"]["DemoAccounts"];

// Порядок и названия групп на экране входа.
export const ROLE_TITLES = [
  ["admin", "Администратор"],
  ["teacher", "Преподаватель"],
  ["trainee", "Обучаемые"],
] as const;
