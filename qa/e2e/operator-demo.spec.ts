import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, join } from "node:path";
import { READBACK, cardQuestions, idle, question, talk } from "./operator-call";
import { OPERATOR_MODULE, OPERATOR_OFF_REASON } from "./operator-module";

test.skip(!OPERATOR_MODULE, OPERATOR_OFF_REASON);

// Демо-ролик «Оператор 112» (до 3 мин, 1920×1080): вход, выбор «112», звонок девушки в
// истерике по подсказкам проводника, ловушка «Дубининская» на повторе адреса, ухудшение и
// совет, разбор и экран результатов. Только по запросу: OPERATOR_DEMO=1 E2E_DATABASE=1.
// Видео пишет Playwright (без звука); голос заявителя накладывает
// scripts/demo/mux_operator_demo.py по журналу воспроизведения (audio.json). Для сведения
// экран в начале и в конце на миг чернеет (flash) — по этим меткам выравниваются сдвиг и
// темп видео; в готовом ролике их нет.
// Учётка demo112 заводится администратором заранее — у тестовых trainee* десятки попыток.

test.skip(
  process.env.E2E_DATABASE !== "1" || process.env.OPERATOR_DEMO !== "1",
  "Ролик — по запросу: E2E_DATABASE=1 OPERATOR_DEMO=1",
);
test.use({
  viewport: { width: 1920, height: 1080 },
  video: { mode: "on", size: { width: 1920, height: 1080 } },
});

const OUT = process.env.OPERATOR_DEMO_OUT ?? "docs/tmp/demo";
const USER = process.env.OPERATOR_DEMO_USER ?? "demo112";
const ID = "fire_apartment_smoke";
const Q = Object.fromEntries(
  cardQuestions(ID).map((item) => [item.key, item.text]),
);

// Курсор и круг на щелчке: headless-запись курсора не показывает. Журнал звука — когда
// какой файл начал и перестал звучать (время — Date.now(), как у меток flash).
const OVERLAY = () => {
  const log: { e: string; src: string; loop?: boolean; t: number }[] = [];
  (window as unknown as { __demoAudio: typeof log }).__demoAudio = log;
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    log.push({ e: "play", src: this.src, loop: this.loop, t: Date.now() });
    const marked = this as unknown as { __demo?: boolean };
    if (!marked.__demo) {
      marked.__demo = true;
      this.addEventListener("ended", () =>
        log.push({ e: "end", src: this.src, t: Date.now() }),
      );
    }
    return play.call(this);
  };
  const pause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
    log.push({ e: "pause", src: this.src, t: Date.now() });
    return pause.call(this);
  };
  const mount = () => {
    const cursor = document.createElement("div");
    Object.assign(cursor.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      width: "18px",
      height: "18px",
      margin: "-9px 0 0 -9px",
      borderRadius: "50%",
      background: "rgba(236, 101, 59, 0.85)",
      border: "2px solid #ffffff",
      boxShadow: "0 0 6px rgba(0,0,0,0.45)",
      zIndex: "2147483646",
      pointerEvents: "none",
      transition: "transform 0.1s",
    });
    document.body.appendChild(cursor);
    document.addEventListener(
      "mousemove",
      (event) => {
        cursor.style.left = `${event.clientX}px`;
        cursor.style.top = `${event.clientY}px`;
      },
      true,
    );
    document.addEventListener(
      "mousedown",
      (event) => {
        cursor.style.transform = "scale(0.7)";
        const ring = document.createElement("div");
        Object.assign(ring.style, {
          position: "fixed",
          left: `${event.clientX - 22}px`,
          top: `${event.clientY - 22}px`,
          width: "44px",
          height: "44px",
          borderRadius: "50%",
          border: "3px solid rgba(236, 101, 59, 0.9)",
          zIndex: "2147483645",
          pointerEvents: "none",
          transition: "transform 0.45s, opacity 0.45s",
        });
        document.body.appendChild(ring);
        requestAnimationFrame(() => {
          ring.style.transform = "scale(1.6)";
          ring.style.opacity = "0";
        });
        setTimeout(() => ring.remove(), 500);
      },
      true,
    );
    document.addEventListener(
      "mouseup",
      () => (cursor.style.transform = "scale(1)"),
      true,
    );
    // Метка времени в каждом кадре: 32 клетки 30×12 px внизу слева — Date.now() по модулю
    // 2^32 в двоичном виде, старший бит слева. Запись экрана идёт неравномерно, поэтому
    // сведение читает время каждого кадра (mux_operator_demo.py) и срезает полоску.
    // Холст, а не клетки-элементы: смена стилей каждый кадр — мутации DOM, на них
    // перерисовывается проводник (GuideBubble) и не успевает показать подсказку.
    const strip = document.createElement("canvas");
    strip.width = 960;
    strip.height = 12;
    Object.assign(strip.style, {
      position: "fixed",
      left: "0px",
      bottom: "0px",
      width: "960px",
      height: "12px",
      zIndex: "2147483646",
      pointerEvents: "none",
    });
    document.body.appendChild(strip);
    const paint = strip.getContext("2d")!;
    const tick = () => {
      const now = Date.now() % 4294967296;
      for (let index = 0; index < 32; index++) {
        const bit = Math.floor(now / 2 ** (31 - index)) % 2;
        paint.fillStyle = bit ? "#fff" : "#000";
        paint.fillRect(index * 30, 0, 30, 12);
      }
      requestAnimationFrame(tick);
    };
    tick();
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
};

const beat = (page: Page, ms: number) => page.waitForTimeout(ms);

// До вопроса о людях — короткие движения и паузы: запись с canvas-меткой замедляет
// страницу, а ухудшение наступает не позже 100 с после приёма. После совета можно
// подробнее показать карточку и разбор. Реплики всегда ждём целиком через idle().
const CALL_TEMPO = {
  moveSteps: 12,
  moveStepMs: 16,
  aimMs: 180,
  afterClickMs: 250,
  readMs: 400,
  menuMs: 350,
};
const REVIEW_TEMPO = {
  moveSteps: 20,
  moveStepMs: 20,
  aimMs: 300,
  afterClickMs: 350,
  readMs: 800,
  menuMs: 600,
};
let tempo = CALL_TEMPO;
let cursor = { x: 960, y: 540 };

async function glide(
  page: Page,
  to: { x: number; y: number },
  steps = tempo.moveSteps,
) {
  const from = cursor;
  for (let step = 1; step <= steps; step++) {
    const k = step / steps;
    const ease = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    await page.mouse.move(
      from.x + (to.x - from.x) * ease,
      from.y + (to.y - from.y) * ease,
    );
    await beat(page, tempo.moveStepMs);
  }
  cursor = to;
}

async function point(page: Page, target: Locator, aim = tempo.aimMs) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await glide(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await beat(page, aim);
}

async function press(page: Page, target: Locator, after = tempo.afterClickMs) {
  await point(page, target);
  await target.click();
  await beat(page, after);
}

async function type(page: Page, target: Locator, text: string, delay = 40) {
  await press(page, target, 150);
  await target.fill("");
  await target.pressSequentially(text, { delay });
  await beat(page, 200);
}

/** Реплика оператора и ответ заявителя: в журнале на две строки больше; потом — дочитать. */
async function exchange(page: Page, action: () => Promise<void>) {
  const lines = talk(page).getByRole("listitem");
  const before = await lines.count();
  await action();
  await expect(lines).toHaveCount(before + 2, { timeout: 30_000 });
  await idle(page);
  await beat(page, tempo.readMs);
}

async function askKey(page: Page, key: string) {
  const button = await question(page, Q[key]!);
  await exchange(page, () => press(page, button, 0));
}

async function readback(page: Page) {
  const button = await question(page, READBACK);
  await exchange(page, () => press(page, button, 0));
}

async function fromMenu(page: Page, menu: RegExp, list: string, item: string) {
  await exchange(page, async () => {
    await press(
      page,
      talk(page).getByRole("button", { name: menu }),
      tempo.menuMs,
    );
    await press(
      page,
      talk(page)
        .getByRole("list", { name: list })
        .getByRole("button")
        .filter({ hasText: item }),
      0,
    );
  });
}

/** Метка для сведения звука: экран на миг чёрный; время — когда кадр отрисован. */
async function flash(page: Page): Promise<number> {
  const at = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const cover = document.createElement("div");
        cover.id = "demo-flash";
        Object.assign(cover.style, {
          position: "fixed",
          inset: "0",
          background: "#000",
          zIndex: "2147483647",
        });
        document.documentElement.appendChild(cover);
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(Date.now())),
        );
      }),
  );
  await beat(page, 700);
  await page.evaluate(() => document.getElementById("demo-flash")?.remove());
  return at;
}

test("демо-ролик: звонок девушки в истерике", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "Ролик пишется в Chromium");
  test.setTimeout(8 * 60_000);
  tempo = CALL_TEMPO;
  cursor = { x: 960, y: 540 };
  const startedAt = Date.now();
  await page.addInitScript(OVERLAY);
  const flashStart = await flash(page);

  // Вход: экран входа тренажёра и выбор обучения.
  await page.goto("/app/login");
  await expect(page.getByLabel("Логин", { exact: true })).toBeVisible();
  await beat(page, 700);
  await type(page, page.getByLabel("Логин", { exact: true }), USER, 50);
  await type(
    page,
    page.getByLabel("Пароль"),
    process.env.DEMO_PASSWORD ?? "demo-local",
    40,
  );
  await press(page, page.getByRole("button", { name: "Войти", exact: true }));
  await expect(
    page.getByRole("heading", { name: "Выберите обучение" }),
  ).toBeVisible();
  await beat(page, 700);
  await press(page, page.getByRole("button", { name: "Оператор 112" }));

  // Входящий вызов: выбираем звонок, проводник включён.
  const incoming = page.getByRole("dialog", { name: "Входящий вызов 112" });
  await expect(incoming).toBeVisible();
  await beat(page, 700);
  await press(page, incoming.getByRole("radio", { name: "Девушка, 22 года" }));
  await expect(
    incoming.getByRole("checkbox", {
      name: "Проводник: подсказка на каждом шаге",
    }),
  ).toBeChecked();
  await press(page, incoming.getByRole("button", { name: "Принять вызов" }), 0);
  await idle(page);
  const tip = page.getByRole("status", { name: "Проводник" });
  await expect(tip).toContainText("Заявитель кричит");
  await beat(page, 350);

  // Истерика: «Успокоить» — просьба с причиной, подряд, пока она не назовёт адрес.
  const reason = "Я вам помогу";
  await fromMenu(page, /^Успокоить/, "Успокоить", reason);
  await fromMenu(page, /^Успокоить/, "Успокоить", reason);

  // Окно разговора переносится за заголовок — освобождаем карточку.
  const panel = (await talk(page).boundingBox())!;
  await point(page, talk(page).getByRole("heading"));
  await page.mouse.down();
  await glide(
    page,
    {
      x: cursor.x + 8 - panel.x,
      y: cursor.y + 1080 - panel.height - 74 - panel.y,
    },
    18,
  );
  await page.mouse.up();
  await beat(page, 400);

  // Адрес «на слух» — с ошибкой, её поймает повтор вслух. Пока пишем — держим контакт,
  // иначе через 18 с тишины заявительница переспросит «Алло?».
  await exchange(page, () =>
    press(
      page,
      talk(page).getByRole("button", { name: "Слышу, записываю" }),
      0,
    ),
  );
  await type(
    page,
    page.getByLabel("Улица:", { exact: true }),
    "Дубининская улица",
    25,
  );
  await type(page, page.getByLabel("Дом/Вл:", { exact: true }), "12", 40);
  await type(
    page,
    page.getByLabel("Квартира/офис:", { exact: true }),
    "47",
    40,
  );
  await type(page, page.getByLabel("Район:"), "Западное Дегунино", 20);
  await askKey(page, "landmark");

  // Повтор адреса вслух: заявительница поправляет улицу, исправляем и повторяем.
  await readback(page);
  await type(
    page,
    page.getByLabel("Улица:", { exact: true }),
    "Дубнинская улица",
    35,
  );
  await readback(page);

  // Шаг 2 — номер для связи.
  await askKey(page, "callback");

  // Тип происшествия: огня нет, только дым — «задымление: квартира».
  await type(
    page,
    page.getByLabel("Тип происшествия"),
    "задымление квартира",
    35,
  );
  await beat(page, 300);
  await press(
    page,
    page.getByRole("button", { name: /^задымление: квартира/ }),
    300,
  );

  // Шаги 3 и 4; после вопроса о людях дым доходит до лестницы — нужен совет.
  await askKey(page, "what_happened");
  await askKey(page, "victims");
  await expect(talk(page)).toContainText("дым уже на лестнице", {
    timeout: 70_000,
  });
  await idle(page);
  await beat(page, tempo.readMs);
  await fromMenu(
    page,
    /^Советы/,
    "Советы",
    "Прикройте нос и рот мокрой тканью",
  );
  tempo = REVIEW_TEMPO;

  // Шаг 5 — газ: от него зависит Мосгаз.
  await askKey(page, "gas");

  // Опросная карта: люди в опасности, дом газифицирован — службы подставляются сами.
  for (const [group, value] of [
    ["Угроза людям", "Да"],
    ["Проведена ли газификация", "Да"],
  ] as const) {
    await press(
      page,
      page
        .getByRole("group", { name: group })
        .getByRole("button", { name: value, exact: true }),
      600,
    );
  }

  // Держим контакт, пока пишем описание своими словами.
  await exchange(page, () =>
    press(
      page,
      talk(page).getByRole("button", { name: "Слышу, записываю" }),
      0,
    ),
  );
  // Окно разговора стоит слева внизу, над описанием, — сворачиваем его на время записи.
  await press(
    page,
    talk(page).getByRole("button", { name: "Свернуть разговор", exact: true }),
  );
  await type(
    page,
    page.getByLabel("Описание со слов заявителя"),
    "Задымление в квартире 47 на пятом этаже: из-под двери густой дым, огня нет. " +
      "В квартире пожилая соседка, не открывает на стук, квартира заперта. " +
      "Дым дошёл до лестничной площадки.",
    20,
  );
  await beat(page, 600);

  // «сохранить» — оценка и разбор звонка.
  await press(
    page,
    page.getByRole("button", { name: "сохранить", exact: true }),
    0,
  );
  const result = page.getByRole("dialog", { name: "Результат попытки" });
  await expect(result).toBeVisible();
  await beat(page, 3200);
  const review = result.getByRole("region", { name: "Разбор звонка" });
  await point(page, review);
  for (let step = 0; step < 5; step++) {
    await page.mouse.wheel(0, 320);
    await beat(page, 600);
  }
  await beat(page, 1000);
  await press(
    page,
    result.getByRole("button", { name: "Закрыть разбор" }),
    400,
  );

  // Выход из 112 — экран результатов тренировок.
  await press(page, page.getByRole("button", { name: "Закрыть карточку" }), 0);
  await expect(page).toHaveURL(/\/app\/operator\/results/);
  await beat(page, 5500);
  const flashEnd = await flash(page);

  // Журнал звука и сами звуковые файлы — для наложения голоса.
  const log: { e: string; src: string; loop?: boolean; t: number }[] =
    await page.evaluate(
      () => (window as unknown as { __demoAudio: [] }).__demoAudio ?? [],
    );
  const dir = join(OUT, "audio");
  mkdirSync(dir, { recursive: true });
  // Короткие звуки сборка встраивает data:-строкой — их раскодируем сами.
  const files: Record<string, string> = {};
  let inline = 0;
  for (const src of new Set(log.map((item) => item.src).filter(Boolean))) {
    const data = /^data:audio\/([\w.+-]+);base64,(.*)$/s.exec(src);
    const name = data
      ? `inline-${++inline}.${data[1] === "mpeg" ? "mp3" : data[1]}`
      : basename(new URL(src).pathname);
    const body = data
      ? Buffer.from(data[2]!, "base64")
      : await (await page.request.get(src)).body();
    writeFileSync(join(dir, name), body);
    files[src] = name;
  }
  const video = page.video()!;
  await page.context().close();
  copyFileSync(await video.path(), join(OUT, "raw.webm"));
  writeFileSync(
    join(OUT, "audio.json"),
    JSON.stringify(
      {
        startedAt,
        flashStart,
        flashEnd,
        log: log.map((item) => ({ ...item, src: files[item.src] ?? "" })),
      },
      null,
      2,
    ),
  );

  // Не принимать дубль, в котором таймер обогнал вопрос или возникло «Алло?».
  const played = log
    .filter((item) => item.e === "play")
    .map((item) => files[item.src] ?? "");
  const victims = played.findIndex((name) => name.startsWith("victims.calm"));
  const escalation = played.findIndex((name) => name.startsWith("escalation-"));
  const advice = played.findIndex((name) => name.startsWith("advice.smoke"));
  expect(victims, "Ответ о людях должен быть спокойным").toBeGreaterThanOrEqual(
    0,
  );
  expect(
    escalation,
    "Ухудшение должно следовать за ответом о людях",
  ).toBeGreaterThan(victims);
  expect(advice, "Совет должен следовать за ухудшением").toBeGreaterThan(
    escalation,
  );
  expect(
    played.filter((name) => /^(pause[.-]|victims\.panic)/.test(name)),
  ).toEqual([]);
  expect(
    flashEnd - startedAt,
    "Весь дубль должен укладываться в три минуты",
  ).toBeLessThanOrEqual(182_000);
});
