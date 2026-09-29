import { createContext, useContext } from "react";
import type { User } from "./api";
import type { RealtimeClient } from "./ws/client";

export const SessionContext = createContext<{
  user: User;
  realtime: RealtimeClient;
} | null>(null);
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("Нет активной сессии.");
  return session;
}
