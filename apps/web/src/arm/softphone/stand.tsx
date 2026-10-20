// Стенд софтфона: смотреть и щёлкать без backend и без чужих экранов.
// Открывается в dev-режиме, в сборку не попадает (входная точка одна — index.html).
// Данные здесь подставные, сеть не работает — действия копятся в очереди.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionContext } from "../../shared/session";
import { RealtimeClient } from "../../shared/ws/client";
import type { Card, User } from "../../shared/api";
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

const CARD_ID = "00000000-0000-4000-8000-000000000200";

// Карточка, из которой окно разговора собирает варианты доклада. В АРМ она лежит в
// кэше реестра (ArmPage), здесь — подставная, как в stand-live.tsx.
const card: Card = {
  id: CARD_ID,
  assignment_id: "00000000-0000-4000-8000-000000000300",
  trainee_id: "00000000-0000-4000-8000-000000000001",
  session_id: "00000000-0000-4000-8000-000000000400",
  state: "accepted",
  appeared_at: "2026-09-19T09:00:00Z",
  delivered_at: "2026-09-19T09:00:05Z",
  opened_at: "2026-09-19T09:00:10Z",
  closed_at: null,
  interrupted_at: null,
  source: {
    number: "10000001",
    incident_type_code: "2020000",
    caller_name: "Учебный заявитель",
    phone_aon: "+79000000001",
    phone_provided: "",
    phone_scene: "",
    address: {
      city: "Москва",
      okrug: "Северный",
      district: "Учебный",
      street: "Дубнинская улица",
      house: "1",
      building: "",
      apartment: "",
    },
    description: "Учебный сценарий",
    tags: ["ДТП"],
    victims: true,
    ambulance_refused: false,
    blocked_people: false,
    emergency: false,
    incident_class: "ДТП с пострадавшими",
    service_ids: ["102"],
  },
  current: { service_number: "", comment: "" },
};

const client = new QueryClient();
client.setQueryData(["services"], SERVICES);
client.setQueryData(["cards"], [card]);

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
            cardId={CARD_ID}
            serviceIds={card.source.service_ids}
            cardState={card.state}
          />
          <p style={{ color: "#fff", padding: "16px", maxWidth: "620px" }}>
            В справочнике нажмите «Позвонить». Свою службу видно первой. После
            вызова идут гудки, через несколько секунд служба отвечает «Слушаю
            вас». Доклад — голосом («Говорить»); без api стенд его не распознаёт
            и служба переспрашивает, после двух раз раскрываются варианты. На
            полный доклад служба отвечает «информация принята» и кладёт трубку,
            на неполный задаёт уточняющий вопрос.
          </p>
        </div>
      </SessionContext.Provider>
    </QueryClientProvider>
  </StrictMode>,
);
