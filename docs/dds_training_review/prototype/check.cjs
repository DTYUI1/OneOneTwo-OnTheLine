// Автопроверка прототипа: Chromium проходит смену как обучаемый (с ошибкой адреса,
// вводными и тревогой), заглядывает во все вкладки и снимает скриншоты.
// Запуск из корня репозитория: node docs/dds_training_review/prototype/check.cjs [папка снимков]
// Время в странице ускорено в SPEED раз; звук выключен — реплики идут по таймеру.
// Снимки по умолчанию — во временной папке системы, не в репозитории.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { chromium } = require(require.resolve("@playwright/test", { paths: [process.cwd()] }));

const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), "dds-proto-shots"));
const PAGE = `file:///${path.resolve(__dirname, "index.html").replace(/\\/g, "/")}`;
const SPEED = 4;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.stack || e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  await page.addInitScript((speed) => {
    const orig = performance.now.bind(performance);
    const t0 = orig();
    performance.now = () => t0 + (orig() - t0) * speed;
  }, SPEED);
  await page.goto(PAGE);

  const taken = new Set();
  const shot = async (name, fullPage = false) => {
    if (taken.has(name)) return;
    taken.add(name);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
    console.log(`  снимок ${name}`);
  };
  const snap = () => page.evaluate(() => window.__ddsProto.snapshot());
  const click = (sel) => page.click(sel, { timeout: 4000 });
  let done = false;
  const log = (text) => console.log(text);

  // ------------------------------------------------------------ смена
  await shot("01-instruktazh");
  await click('[data-act="startShift"]');
  await click('[data-act="toggleSound"]');

  const sent = { news: false, duplicate: false, noAnswer: false, alarm: false };
  async function inject(id) {
    await click('[data-act="menu"][data-id="inject"]');
    await shot("07-vvodnye");
    await click(`[data-act="inject"][data-id="${id}"]`);
    sent[id] = true;
    log(`вводная: ${id}`);
  }

  async function openPhone(s) { if (!s.phone) { await click('[data-act="phone"]'); return true; } return false; }

  async function dial(s, id) {
    if (await openPhone(s)) return;
    await click(`[data-dial="${id}"]`);
    log(`звонок ${id}`);
  }

  function needs(c, s) {
    if (!c.addr && c.id !== "c3") return { what: "адрес", run: () => typeAddress(c) };
    if (c.status === "received") return { what: "первичный статус", run: () => primary(s, c) };
    if (c.status === "accepted" && !c.brigade && c.id !== "c3") return { what: "направить", run: () => send(s) };
    if (c.id === "c3") return null;
    if (!c.doklad101) return { what: "доклад 101", run: () => dial(s, "101") };
    const ev = c.ev;
    if (ev.noAnswer && ev.noAnswer.reserveAt == null) return { what: "резерв", run: () => dial(s, "reserve") };
    if (ev.alarm && ev.alarm.call103At == null) return { what: "скорая по тревоге", run: () => dial(s, "103") };
    if (ev.request && ev.request.handledAt == null) return { what: "скорая по просьбе", run: () => dial(s, "103") };
    if (ev.alarm && ev.alarm.report101At == null) return { what: "доклад о тревоге", run: () => dial(s, "101") };
    if (c.id === "c2" && ev.addrFix && !/дубнин/i.test(c.addr)) return { what: "исправить адрес", run: () => fixAddress() };
    if (ev.news && ev.news.relayedAt == null) return { what: "передать сведения", run: () => callBrigade(s, c) };
    if (ev.silence && ev.silence.checkedAt == null && !c.reports.includes("completion")) return { what: "проверить молчащий расчёт", run: async () => { await openPhone(s); await page.waitForTimeout(200); await shot("10-molchit-raschet"); await callBrigade(await snap(), c); } };
    if (c.next) return { what: `статус ${c.next}`, run: () => status(s, c.next) };
    return null;
  }

  async function typeAddress(c) {
    await page.fill("#addr-input", "");
    if (c.id === "c2") {
      // Ловушка: первая подсказка — Дубининская (ЮАО), а вызов из САО.
      await page.type("#addr-input", "Дуб");
      await page.waitForSelector(".suggest-item");
      await shot("04-podskazka-ulic");
      await click(".suggest-item");
      await page.type("#addr-input", "32");
    } else {
      await page.fill("#addr-input", "Бескудниковский бульвар, д. 24, кв. 115");
    }
    await click('[data-act="saveAddr"]');
    log(`адрес ${c.id}`);
  }

  async function fixAddress() {
    await page.fill("#addr-input", "Дубнинская улица, д. 32");
    await click('[data-act="saveAddr"]');
    log("адрес c2 исправлен");
  }

  async function primary(s, c) {
    if (!s.form) { await click('[data-act="tile"]'); await shot("03-kartochka-provodnik"); }
    await click('[data-act="sampleComment"]');
    await click('[data-act="saveStatus"]');
    log(`первичный статус ${c.id}`);
  }

  async function send(s) {
    if (await openPhone(s)) return;
    await page.check('input[data-bind="pickBrigade"]');
    await shot("04b-tablo-sil");
    await click('[data-act="sendBrigade"]');
    log("расчёт направлен");
  }

  async function callBrigade(s, c) {
    if (await openPhone(s)) return;
    await click(`[data-act="callBrigade"][data-id="${c.brigade}"]`);
    log(`звонок расчёту ${c.brigade}`);
  }

  async function status(s, value) {
    if (!s.form) await click('[data-act="tile"]');
    await page.selectOption("#sf-status", value);
    await page.fill("#sf-comment", value === "completed" ? "Работы завершены, пострадавших передали скорой" : "");
    await click('[data-act="saveStatus"]');
    log(`статус ${value}`);
  }

  async function handleCall(s) {
    const c = s.call;
    if (c.replies) {
      await page.waitForTimeout(300);
      await shot(`call-${c.card}-vopros`);
      await click('[data-act="reply"][data-id="0"]');
      return;
    }
    if (c.dir === "out" && c.target && c.stage === "talk") {
      await click('[data-act="sampleDoklad"]');
      await shot("05-doklad-po-skheme");
      await click('[data-act="hangup"]');
      return;
    }
    if (c.stage === "result") { await page.waitForTimeout(300); await shot("06-proverka-doklada"); await click('[data-act="hangup"]'); return; }
    if (c.stage === "failed") { await shot("12-sluzhba-ne-otvechaet"); await click('[data-act="hangup"]'); return; }
    if (c.canHang) { await click('[data-act="hangup"]'); return; }
    await page.waitForTimeout(150);
  }

  async function stopFrame() {
    await page.waitForTimeout(300);
    await shot("11-stop-kadr");
    for (let q = 0; q < 3; q++) await click(`[data-act="sfAnswer"][data-q="${q}"]`);
    await click('[data-act="sfCheck"]');
    await shot("11b-stop-kadr-otvety");
    await click('[data-act="sfClose"]');
  }

  const started = Date.now();
  let listShot = false;
  let misses = 0;
  while (Date.now() - started < 6 * 60 * 1000) {
    try {
      await step();
      misses = 0;
    } catch (error) {
      // Стоп-кадр или звонок могут появиться посреди щелчка — смотрим состояние заново.
      misses += 1;
      log(`  повтор после: ${String(error.message).split("\n")[0]}`);
      if (misses > 8) throw error;
    }
    if (done) break;
  }
  async function step() {
    const s = await snap();
    if (s.cards.length && !listShot && s.view === "list") { await page.waitForTimeout(300); await shot("02-spisok-provodnik"); listShot = true; }
    if (s.modal === "confirmComplete") { await click('[data-act="confirmComplete"]'); return; }
    if (s.stop) { await stopFrame(); return; }
    if (s.call) { await handleCall(s); return; }
    if (s.ringing.length) {
      const r = s.ringing[0];
      if (r.alarm) await shot("08-trevoga");
      if (r.kind === "arrival_wrong") await shot("09-raschet-ne-tam");
      await click(`[data-act="answer"][data-id="${r.id}"]`);
      log(`ответ: ${r.kind}`);
      return;
    }
    const c1 = s.cards.find((c) => c.id === "c1");
    if (c1 && !sent.duplicate && c1.brigade) { await inject("duplicate"); return; }
    if (c1 && !sent.news && c1.status === "arrived") { await inject("news"); return; }
    if (c1 && !sent.noAnswer && c1.status === "working") { await inject("noAnswer"); return; }
    if (c1 && !sent.alarm && sent.noAnswer && c1.status === "working") { await inject("alarm"); return; }
    const open = s.cards.filter((c) => !c.closed);
    if (s.cards.length >= 3 && !open.length) { done = true; return; }
    const ordered = [...open].sort((a, b) => (a.id === s.view ? -1 : b.id === s.view ? 1 : a.id.localeCompare(b.id)));
    let acted = false;
    for (const c of ordered) {
      const need = needs(c, s);
      if (!need) continue;
      if (s.view !== c.id) await click(`[data-act="open"][data-id="${c.id}"]`);
      else await need.run();
      acted = true;
      break;
    }
    if (!acted) await page.waitForTimeout(250);
  }
  const final = await snap();
  log(`карточки: ${final.cards.map((c) => `${c.id}=${c.status}`).join(", ")}`);
  if (final.cards.some((c) => !c.closed)) problems.push("смена не дошла до конца: есть незакрытые карточки");

  // ------------------------------------------------------------ разборы и итоги
  await click('[data-act="list"]');
  for (const id of ["c1", "c2", "c3"]) {
    await click(`[data-act="review"][data-id="${id}"]`);
    await page.waitForTimeout(200);
    await shot(`13-razbor-${id}`, true);
    await click('[data-act="list"]');
  }
  await click('[data-act="endShift"]');
  await click('[data-act="finishShift"]');
  await shot("14-itogi-smeny");
  await click('[data-act="modalClose"]');

  // ------------------------------------------------------------ разминка
  await click('[data-act="scene"][data-id="drills"]');
  await shot("20-razminka");
  await click('[data-act="drill"][data-id="address"]');
  await shot("21-adresa");
  // Пока показан ответ, нажатия не считаются — жмём, пока не появится итог.
  for (let i = 0; i < 60 && !(await page.$(".drill-result")); i++) {
    await page.keyboard.press(i % 3 ? "ArrowRight" : "ArrowLeft");
    await page.waitForTimeout(400);
  }
  await page.waitForSelector(".drill-result", { timeout: 5000 });
  await shot("21b-adresa-itog");
  await click('[data-act="drillMenu"]');
  await click('[data-act="drill"][data-id="routing"]');
  await click('[data-act="routePick"][data-id="103"]');
  await click('[data-act="routeCheck"]');
  await shot("22-kogo-napravit");
  await click('[data-act="drillMenu"]');
  await click('[data-act="drill"][data-id="status"]');
  await click('[data-act="statusPick"][data-id="completed"]');
  await shot("23-status-po-dokladu");
  await click('[data-act="drillMenu"]');
  await click('[data-act="drill"][data-id="comment"]');
  await page.fill("#drill-comment", "Принята. Рублёвское шоссе у ТЦ Европарк: наезд на пешехода, мужчина в сознании, травма головы. Направлен наряд.");
  await click('[data-act="commentCheck"]');
  await shot("24-kommentariy");

  // ------------------------------------------------------------ пульт, путь, пример
  await click('[data-act="scene"][data-id="teacher"]');
  await click('[data-act="teacherMenu"][data-id="3"]');
  await shot("30-pult-vvodnye");
  await click('[data-act="teacherTab"][data-id="class"]');
  await click('[data-act="classStart"]');
  await page.waitForTimeout(7000);
  await shot("31-klass-seychas");
  await click('[data-act="teacherTab"][data-id="dor"]');
  await shot("32-verdikt-po-kategoriyam", true);
  await click('[data-act="scene"][data-id="path"]');
  for (const n of ["73120202", "73120204", "73120205"]) await click(`[data-act="majorPick"][data-id="${n}"]`);
  await click('[data-act="majorCheck"]');
  await shot("40-moy-put", true);
  await click('[data-act="scene"][data-id="example"]');
  await shot("50-primer-c1", true);
  await click('[data-act="exampleCard"][data-id="c2"]');
  await shot("51-primer-c2", true);

  await browser.close();
  if (problems.length) {
    console.log("ПРОБЛЕМЫ:");
    for (const p of problems) console.log(`  ${p}`);
    process.exit(1);
  }
  console.log(`Готово, ошибок в консоли нет. Снимки: ${OUT}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
