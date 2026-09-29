// Стенд софтфона: смотреть и щёлкать без backend и без чужих экранов.
// Открывается в dev-режиме, в сборку не попадает (входная точка одна — index.html).
// Данные здесь подставные, сеть не работает — действия копятся в очереди,
// а загрузка записи честно не проходит: так и выглядит путь ошибки.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionContext } from "../../shared/session";
import { RealtimeClient } from "../../shared/ws/client";
import type { User } from "../../shared/api";
import type { components } from "../../api-client/schema";
import { Softphone } from "./Softphone";
import "../../shared/tokens.css";

type Service = components["schemas"]["Service"];

const SERVICES: Service[] = [
  ["101", "Служба 101", "voice-1"],
  ["102", "Служба 102", "voice-2"],
  ["103", "Скорая помощь", "voice-3"],
  ["104", "Мосгаз", "voice-4"],
  ["GKH", "ЖКХ", "voice-1"],
  ["MOSLIFT", "Мослифт", "voice-2"],
].map(([id, name, voice], index) => ({
  id,
  code: id,
  name,
  category: "demo",
  phone_ext: String(101 + index),
  voice_profile: voice,
  is_active: true,
}));

const client = new QueryClient();
client.setQueryData(["services"], SERVICES);

const user: User = {
  id: "00000000-0000-4000-8000-000000000001",
  login: "trainee01",
  full_name: "Обучаемый 01",
  role: "trainee",
  workstation_number: 1,
  dds_service_id: "102",
  is_active: true,
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <SessionContext.Provider
        value={{ user, realtime: new RealtimeClient(user.id, () => {}) }}
      >
        <div style={{ background: "#849097", minHeight: "100vh" }}>
          <Softphone
            cardId="00000000-0000-4000-8000-000000000200"
            serviceIds={["102"]}
          />
          <p style={{ color: "#fff", padding: "16px", maxWidth: "620px" }}>
            Нажмите «Телефон» в полосе. Службу карточки видно первой. После
            вызова идут гудки, через несколько секунд служба отвечает и
            начинается запись доклада; «Положить трубку» даёт ответную реплику и
            завершает звонок. Микрофон браузер спросит один раз — откажите,
            чтобы посмотреть, как софтфон ведёт себя без него.
          </p>
        </div>
      </SessionContext.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
