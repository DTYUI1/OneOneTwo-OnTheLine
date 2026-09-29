import createClient from "openapi-fetch";
import type { components, paths } from "../api-client/schema";

export type User = components["schemas"]["User"];
export type Card = components["schemas"]["Card"];
export type CardEvent = components["schemas"]["CardEvent"];
export type Scenario = components["schemas"]["Scenario"];
export type ServerEvent = components["schemas"]["WsServerEvent"];
export const api = createClient<paths>({
  baseUrl: "/api",
  credentials: "include",
});

export function csrfToken(): string {
  const entry = document.cookie
    .split("; ")
    .find((item) => item.startsWith("csrf="));
  return entry ? decodeURIComponent(entry.slice(5)) : "";
}

api.use({
  onRequest({ request }) {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      request.headers.set("X-CSRF-Token", csrfToken());
    }
    return request;
  },
});
