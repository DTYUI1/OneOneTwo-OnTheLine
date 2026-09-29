// Отправка записи доклада. В D1 мок отвечает 501 — это штатный путь, а не сбой:
// запись остаётся на руках, обучаемый видит спокойную строку и кнопку повтора.
// Долговечная очередь — зона `shared/ws` у капитана; второй клиент здесь не заводим.

import { api, csrfToken } from "../../shared/api";

export interface UploadResult {
  readonly ok: boolean;
  /** Можно повторить: запись стоит придержать. */
  readonly retryable: boolean;
  readonly note: string | null;
}

const HELD =
  "Запись сохранена и будет отправлена позже. Звонок уже засчитан по факту, времени и адресату.";

export function uploadOutcome(status: number): UploadResult {
  if (status >= 200 && status < 300)
    return { ok: true, retryable: false, note: null };
  // 501 — загрузка ещё не реализована на сервере; 5xx и 0 — связь.
  if (status === 501 || status >= 500 || status === 0)
    return { ok: false, retryable: true, note: HELD };
  // 409 — сервер ещё не закрыл звонок: отбой в очереди, повтор пройдёт.
  if (status === 409 || status === 401 || status === 403)
    return { ok: false, retryable: true, note: HELD };
  return {
    ok: false,
    retryable: false,
    note: "Сервер не принял запись. Звонок засчитан по факту, времени и адресату.",
  };
}

export async function uploadAudio(
  callId: string,
  blob: Blob,
): Promise<UploadResult> {
  const form = new FormData();
  form.append("audio", blob, "report");
  try {
    const { response } = await api.POST("/calls/{id}/audio", {
      params: {
        path: { id: callId },
        header: { "X-CSRF-Token": csrfToken() },
      },
      // Тело целиком собирает bodySerializer; поле здесь — требование типа из контракта.
      body: { audio: "" },
      bodySerializer: () => form,
    });
    return uploadOutcome(response.status);
  } catch {
    return uploadOutcome(0);
  }
}
