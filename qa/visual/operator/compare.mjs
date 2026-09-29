// Без библиотек обработки изображений: эталон, наложение и разница — Canvas в Chromium.
import { chromium, expect } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve(process.env.OPERATOR_VISUAL_OUT ?? "docs/operator_112_review/stage4");
mkdirSync(`${out}/overlay`, { recursive: true });
const browser = await chromium.launch({ args: ["--disable-features=OverlayScrollbar,FluentOverlayScrollbar"] });
const page = await browser.newPage({ viewport: { width: 2133, height: 1070 }, deviceScaleFactor: 0.9 });
page.setDefaultTimeout(15000);
await page.addInitScript(() => {
  localStorage.setItem("arm112:welcome:v1:00000000-0000-0000-0000-000000000001", "seen");
  localStorage.setItem("arm112:help-tip:v1:00000000-0000-0000-0000-000000000001", "seen");
});
const base = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.route("**/api/**", route => {
  if (route.request().url().endsWith("/auth/me")) return route.fulfill({ json: {
    id: "00000000-0000-0000-0000-000000000001", login: "teacher", full_name: "Оператор", role: "teacher", workstation_number: 4,
  } });
  if (route.request().url().endsWith("/health")) return route.fulfill({ json: { status: "ok", mode: "mock" } });
  return route.fulfill({ status: 404, json: { code: "not_found", message: "", details: {} } });
});
await page.clock.install({ time: new Date("2026-09-17T08:38:33Z") });
const results = [];
let acceptedAt = 0;
async function open() {
  console.log("Открытие карточки");
  await page.goto(`${base}/app/operator?scenario=fire_apartment_smoke`);
  const welcome = page.getByRole("button", { name: "Начать работу", exact: true });
  await expect(welcome.or(page.getByRole("checkbox", { name: /Проводник:/ }))).toBeVisible();
  if (await welcome.isVisible()) await welcome.click();
  await page.getByRole("checkbox", { name: /Проводник:/ }).uncheck();
  await page.getByRole("button", { name: "Принять вызов", exact: true }).click();
  acceptedAt = await page.evaluate(() => Date.now());
  const collapse = page.getByRole("button", { name: "Свернуть разговор", exact: true });
  if (await collapse.isVisible()) await collapse.click();
  console.log("Разговор свёрнут");
}
async function choose(label) {
  await page.getByLabel("Тип происшествия", { exact: true }).click();
  await page.getByRole("list", { name: "Группы происшествий" }).getByRole("button", { name: label, exact: true }).click();
}
async function clearServices() {
  const buttons = page.getByRole("list", { name: "Службы", exact: true }).getByRole("button");
  while (await buttons.count()) await buttons.first().click();
}
async function mark(group, name) {
  await page.getByRole("group", { name: group, exact: true }).getByRole("button", { name, exact: true }).click();
}
async function shot(id, time, number = "36814851") {
  console.log("Снимок", id);
  const [minutes, seconds] = time.split(":").map(Number);
  await page.clock.setSystemTime(acceptedAt + (minutes * 60 + seconds) * 1000 - 1000);
  await page.clock.runFor(1000);
  // Только переменные реквизиты звонка: одинаковые данные при любом времени запуска.
  // Геометрия, стили, выбор карточки и служб не подменяются.
  await page.evaluate(({ time, number, id }) => {
    const header = document.querySelector('[data-help="operator-header"]');
    header.querySelector("h1").textContent = `Происшествие ${number}`;
    const incident = header.querySelector("h1").parentElement;
    incident.querySelector("p").textContent = `Сохр. 17.09.2026 в ${number === "36814849" ? "11:35:25" : number === "36814850" ? "11:37:02" : "11:38:33"}`;
    header.querySelectorAll("input").forEach(input => { input.value = ""; });
    header.querySelector('[role="timer"] strong').textContent = time;
  }, { time, number, id });
  await page.mouse.move(0, 0);
  const render = await page.screenshot({ path: `${out}/${id}.png`, animations: "disabled" });
  const source = readFileSync(`docs/screenshots/card_112/${id}.png`);
  const comparison = await page.evaluate(async ({ actual, source }) => {
    const load = src => new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image); image.src = src; });
    const [a, r] = await Promise.all([load(actual), load(source)]);
    const canvas = () => Object.assign(document.createElement("canvas"), { width: 1920, height: 963 });
    const ref = canvas(), current = canvas(), overlay = canvas(), diff = canvas();
    ref.getContext("2d").drawImage(r, 0, 77, 1920, 963, 0, 0, 1920, 963);
    current.getContext("2d").drawImage(a, 0, 0);
    const ctx = overlay.getContext("2d"); ctx.drawImage(ref, 0, 0); ctx.globalAlpha = 0.5; ctx.drawImage(current, 0, 0);
    const original = ref.getContext("2d").getImageData(0, 0, 1920, 963);
    const rendered = current.getContext("2d").getImageData(0, 0, 1920, 963);
    const delta = diff.getContext("2d").createImageData(1920, 963);
    let changed = 0, count = 0, absolute = 0;
    for (let y = 0; y < 963; y++) for (let x = 0; x < 1920; x++) {
      const i = (y * 1920 + x) * 4;
      // Единственная маска — водяной знак Windows, включая его вторую строку.
      const masked = x >= 1390 && x < 1850 && y >= 871 && y < 914;
      const d = Math.max(...[0, 1, 2].map(c => Math.abs(original.data[i+c] - rendered.data[i+c])));
      if (!masked) { count++; absolute += d; if (d > 24) changed++; }
      delta.data.set(masked ? [100,100,100,255] : d > 24 ? [255,0,80,255] : [255-d,255-d,255-d,255], i);
    }
    diff.getContext("2d").putImageData(delta, 0, 0);
    const colors = {};
    for (let i = 0; i < original.data.length; i += 4) { const key = [...original.data.slice(i,i+3)].map(c => c.toString(16).padStart(2,"0")).join(""); colors[key] = (colors[key] ?? 0) + 1; }
    const samples = [[440,950],[10,600],[1200,300],[1907,400],[1907,220]].map(([x,y]) => ({ x,y, rgb: [...original.data.slice((y*1920+x)*4,(y*1920+x)*4+3)] }));
    return { ratio: changed/count, meanDelta: absolute/count, changed, count, samples,
      colors: Object.entries(colors).sort((a,b)=>b[1]-a[1]).slice(0,12),
      reference: ref.toDataURL(), overlay: overlay.toDataURL(), diff: diff.toDataURL() };
  }, { actual: `data:image/png;base64,${render.toString("base64")}`, source: `data:image/png;base64,${source.toString("base64")}` });
  for (const kind of ["reference", "overlay", "diff"]) {
    writeFileSync(`${out}/overlay/${id}-${kind}.png`, Buffer.from(comparison[kind].split(",")[1], "base64")); delete comparison[kind];
  }
  results.push({ id, ...comparison, passed: comparison.ratio <= 0.05 });
  console.log(id, (comparison.ratio*100).toFixed(3) + "%", comparison.colors.slice(0,6));
}
await open();
await page.locator('[data-help="operator-header"] input').first().focus();
await shot("01", "00:09");
await choose("101");
await clearServices();
// В 02/04 опросная карта прокручена на 23 CSS px: верх заголовка скрыт.
await page.locator('[data-help="operator-card"] > div').last().evaluate(el => { el.scrollTop = 23; });
await shot("02", "01:23");
for (const name of ["Квартира", "Газовая колонка", "Подъезд"]) await mark("Внутридомовые объекты (пламя, дым)", name);
await page.getByRole("button", { name: "Добавить службы", exact: true }).click();
const services = page.getByRole("dialog");
for (const name of [/^Служба 101/, /^Служба 104/, /^Служба 102/, "Деп. ЖКХ", "ЦЭМП", "ЦОДД", "Мос.Без.", "Мослифт"]) {
  const b = services.getByRole("button", { name, exact: typeof name === "string" });
  if (await b.getAttribute("aria-pressed") !== "true") await b.click();
}
await page.getByRole("button", { name: "Сохранить и закрыть", exact: true }).click();
await page.locator('[data-help="operator-card"] > div').last().evaluate(el => { el.scrollTop = 23; });
await shot("04", "02:07");
await page.getByRole("button", { name: "Добавить службы", exact: true }).click();
await shot("03", "02:38");
await open();
await page.getByLabel("Тип происшествия", { exact: true }).click();
await shot("06", "00:44", "36814849");
await choose("104");
await clearServices();
await shot("07", "01:03", "36814849");
await open();
await page.getByLabel("Тип происшествия", { exact: true }).click();
await page.getByRole("list", { name: "Группы происшествий" }).evaluate(el => { el.scrollTop = 240; });
await shot("08", "00:09", "36814850");
await page.getByRole("list", { name: "Группы происшествий" }).getByRole("button", { name: "Взрыв", exact: true }).click();
await clearServices();
await shot("09", "00:32", "36814850");
writeFileSync(`${out}/overlay/metrics.json`, JSON.stringify({ threshold: { channelDelta: 24, maxRatio: 0.05 }, errors, results }, null, 2));
writeFileSync(`${out}/overlay/index.html`, `<!doctype html><html lang="ru"><meta charset="utf-8">
<title>Оператор 112 — наложения</title><style>
body{margin:20px;font:16px system-ui;background:#e8ecef;color:#16212a}header{position:sticky;top:0;background:#fff;padding:12px;z-index:2}label{margin-right:24px}figure{margin:24px 0}figcaption{padding:8px;background:white}.frame{position:relative;width:1920px;max-width:100%;aspect-ratio:1920/963}.frame img{position:absolute;inset:0;width:100%;height:100%}.actual{opacity:.5}.diff{display:none}a{margin-right:16px}input{vertical-align:middle}
</style><header><b>Сверка АРМ 112</b> <label>Доля нового экрана <input id="blend" type="range" min="0" max="100" value="50"> <output id="amount">50 %</output></label><label><input id="delta" type="checkbox"> Карта разницы</label><span>Порог 5 %, разность канала &gt;24. Серое — маска Windows.</span></header>
${results.map(r => `<figure><figcaption><b>${r.id}</b> — ${(100*r.ratio).toFixed(3)} %; ${r.passed ? "в пределах порога" : "порог превышен"}. <a href="${r.id}-reference.png">Эталон</a><a href="../${r.id}.png">Экран</a><a href="${r.id}-overlay.png">Наложение</a></figcaption><div class="frame"><img src="${r.id}-reference.png" alt="Эталон ${r.id}"><img class="actual" src="../${r.id}.png" alt="Экран ${r.id}"><img class="diff" src="${r.id}-diff.png" alt="Разница ${r.id}"></div></figure>`).join("\n")}
<script>document.querySelector('#blend').oninput=e=>{document.querySelectorAll('.actual').forEach(i=>i.style.opacity=e.target.value/100);document.querySelector('#amount').textContent=e.target.value+' %'};document.querySelector('#delta').onchange=e=>document.querySelectorAll('.diff').forEach(i=>i.style.display=e.target.checked?'block':'none');</script></html>`);
await browser.close();
if (errors.length || results.some(r => !r.passed)) process.exitCode = 1;
