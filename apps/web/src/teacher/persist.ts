// Состояние пульта, которое должно пережить перезагрузку страницы: открытый раздел
// и несохранённые правки. sessionStorage — вкладка своя у каждого окна; хранилище
// может быть недоступно (приватный режим), поэтому ошибки молча игнорируются.
export function readJSON<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Без хранилища пульт работает, просто без восстановления после reload.
  }
}

export function removeKey(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // см. writeJSON
  }
}

export const VIEW_KEY = "teacher:view";
export const STUDIO_KEY = "teacher:studio";
export const draftKey = (scenarioId: string) => `teacher:draft:${scenarioId}`;
