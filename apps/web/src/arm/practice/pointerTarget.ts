// Цель подсказки проводника (DT-07) на экране: какой элемент имеет в виду шаг и какой
// фразой о нём сказать. Фраза — в подсказке «Вместе» у этого элемента (решение 17.10,
// TrainerCoach.tsx); курсор тренажёра указывает на него в «Покажи» и в показе.
//
// Цели ищутся в разметке карточки по их собственным подписям и data-help; телефон ДДС —
// окно ArmPage (data-help="card-phone", GP-09): пока оно закрыто, указываем на значок.
import type { PointerTip } from "./pointer";

/**
 * Кнопка по имени: aria-label, иначе текст. «Положить трубку» с геймплея ДДС — значок без
 * текста (CallFooter.tsx): по тексту её не найти, и подсказка уходила к значку телефона.
 */
function buttonByText(
  root: ParentNode,
  test: (text: string) => boolean,
): HTMLElement | null {
  for (const button of root.querySelectorAll<HTMLButtonElement>("button"))
    if (
      !button.disabled &&
      test(
        button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
      )
    )
      return button;
  return null;
}

const visible = (el: Element | null): el is HTMLElement =>
  !!el && el.getClientRects().length > 0;

/**
 * Вводная бригаде в разговоре (GP-05): варианты шага, если они раскрыты (или микрофона нет), иначе
 * «По частям» рядом с «Говорить» в ряду ответа бригаде.
 */
function briefControl(phone: Element | null): Element | null {
  const parts = phone
    ?.querySelector('button[data-reply="brief"]')
    ?.closest('[role="group"]');
  if (visible(parts ?? null)) return parts ?? null;
  return (
    phone?.querySelector(
      '[aria-label="Ответ бригаде голосом"] button[data-parts]:not(:disabled)',
    ) ?? null
  );
}

/** Строка статуса закрыта: шаг статуса начинается с карандаша своей плитки. */
export const PENCIL_TEXT =
  "Карандаш на своей плитке или Alt+Z — откроется строка статуса.";

/** Элемент, на который указать, и фраза к нему; null — цель сейчас не на экране. */
export function findPointer(
  card: HTMLElement,
  tip: PointerTip,
): { readonly el: HTMLElement; readonly text: string } | null {
  // Телефон ДДС — окно ArmPage (GP-09), не разметка карточки.
  const phone = document.querySelector('[data-help="card-phone"]');
  // Состояние линии — в шапке окна телефона (data-call-state).
  const line =
    phone
      ?.querySelector("[data-call-state]")
      ?.getAttribute("data-call-state") ?? null;
  const hangup = buttonByText(document, (text) => text === "Положить трубку");
  if (visible(hangup)) {
    // Гудки — молчим: «положите трубку» до ответа сбросило бы вызов.
    if (line !== "talking") return null;
    // Идёт разговор — следующий шаг в окне разговора. Цели в нём нет (идёт запись голоса, на
    // линии не бригада) — молчим: значок телефона на панели в разговоре ничего не даст.
    if (tip.talkText) {
      const el = tip.talkTarget === "brief" ? briefControl(phone) : hangup;
      return visible(el) ? { el, text: tip.talkText } : null;
    }
  }
  let el: Element | null = null;
  if (tip.target === "action") {
    el = card.querySelector('[data-help="card-action"] select');
    // Строка статуса закрыта (DT-17, как в АРМ): сначала — карандаш своей плитки.
    const pencil = card.querySelector('button[aria-label="Изменить статус"]');
    if (!visible(el) && visible(pencil))
      return { el: pencil, text: PENCIL_TEXT };
  }
  if (tip.target === "brigades" && phone)
    el = phone.querySelector("[data-forces]");
  if (tip.target === "brigade-call" && phone)
    el = phone.querySelector('button[data-state="here"]');
  if (tip.target === "answer" && phone)
    // Звонящая линия — вкладка на плашке звонков (вкладки 17.10): щелчок отвечает, идущий
    // разговор уходит на удержание. Кнопки «Ответить» больше нет — по ней курсор показа
    // искал вызов и пропускал его.
    el = phone.querySelector('[role="tab"][data-line="ringing"]');
  if (tip.target === "hangup")
    el = buttonByText(document, (text) => text === "Положить трубку");
  if (visible(el)) return { el, text: tip.text };
  // Окно телефона закрыто: цель в нём — сначала значок телефона на панели.
  const dial = document.querySelector('button[aria-label^="Телефон"]');
  if (
    ["brigades", "brigade-call", "answer"].includes(tip.target) &&
    visible(dial)
  )
    return { el: dial, text: tip.text };
  return null;
}
