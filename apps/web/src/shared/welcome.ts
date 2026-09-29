const acknowledged = new Set<string>();

function storageKey(userId: string): string {
  return `arm112:welcome:v1:${userId}`;
}

export function hasSeenWelcome(userId: string): boolean {
  if (acknowledged.has(userId)) return true;
  try {
    return localStorage.getItem(storageKey(userId)) === "seen";
  } catch {
    // Запрет browser storage не должен блокировать вход в тренажёр.
    return false;
  }
}

export function acknowledgeWelcome(userId: string): void {
  acknowledged.add(userId);
  try {
    localStorage.setItem(storageKey(userId), "seen");
  } catch {
    // При недоступном storage запоминаем выбор до перезагрузки страницы.
  }
}

// Обучаемый выбирает обучение (оператор 112 или диспетчер) при каждом входе:
// вход снимает отметку, а перезагрузка страницы после выбора её сохраняет.
export function forgetWelcome(userId: string): void {
  acknowledged.delete(userId);
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // Без storage отметка и так живёт только до перезагрузки.
  }
}

// Подсказка-стрелка к кнопке «?» (28.09): один раз после приветствия, у каждого
// аккаунта своя отметка. Показ запоминается так же, как приветствие.
const tipShown = new Set<string>();

function tipKey(userId: string): string {
  return `arm112:help-tip:v1:${userId}`;
}

export function hasSeenHelpTip(userId: string): boolean {
  if (tipShown.has(userId)) return true;
  try {
    return localStorage.getItem(tipKey(userId)) === "seen";
  } catch {
    return false;
  }
}

export function acknowledgeHelpTip(userId: string): void {
  tipShown.add(userId);
  try {
    localStorage.setItem(tipKey(userId), "seen");
  } catch {
    // Без storage подсказка не повторится до перезагрузки страницы.
  }
}
