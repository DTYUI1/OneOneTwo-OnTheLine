import type { User } from "./api";

/** После входа возвращаем только на известную страницу, доступную этой роли. */
export function loginDestination(
  role: User["role"],
  returnTo: unknown,
): string {
  const home = role === "trainee" ? "/arm" : `/${role}`;
  if (typeof returnTo !== "string") return home;
  const pathname = returnTo.split(/[?#]/, 1)[0];
  // Белый список не позволяет истории входа превратиться во внешнюю ссылку
  // или открыть кабинет другой роли. Права на саму карточку проверяет API.
  const traineePage =
    [
      "/operator",
      "/arm",
      "/arm/results",
      "/arm/reference",
      "/results",
    ].includes(pathname) || /^\/arm\/cards\/[a-z\d_-]+$/i.test(pathname);
  const allowed =
    role === "trainee"
      ? traineePage
      : pathname === "/teacher" || (role === "admin" && pathname === "/admin");
  return allowed ? returnTo : home;
}
