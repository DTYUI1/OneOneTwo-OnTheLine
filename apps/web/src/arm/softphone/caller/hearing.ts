// Что заявитель понял из фразы диспетчера (HQ-019, docs/dds_caller.md, раздел 2.3): какие
// вопросы заданы, представился ли диспетчер, прочитал ли адрес вслух. Голос и варианты по
// частям идут одним правилом: вариант — тоже фраза. Ключевые слова, как у `briefing_check`:
// общие (служба, просьба подойти, прощание, адрес вслух) — здесь, вопросы о сведениях и слова
// повода — в таблице сюжета. Зеркало — `hear` в apps/api/app/tools/coherence/caller.py, общая
// таблица примеров — hearing.cases.json. Распознавание (faster-whisper) пишет числа и цифрами, и словами — читаются оба.

/**
 * Сведение сюжета, о котором диспетчер может спросить: ключ `plot_facts` книг заявителя и
 * таблицы сюжета (`scripts/voices/bank/callers/plots/<сюжет>.json`).
 */
export type Fact = string;

/** Таблица сюжета, собранная для распознавания: код заявителя общий для всех сюжетов. */
export interface CallerStory {
  /** Сведения в порядке вариантов «По частям»: вопрос на кнопке и слова, по которым он узнаётся. */
  readonly facts: readonly {
    readonly fact: Fact;
    readonly ask: string;
    readonly hear: RegExp;
    /** Сведение, ради которого звонят: его вопрос всегда на кнопке, пока нет полного ответа. */
    readonly key: boolean;
  }[];
  /** Слова повода звонка сверх общих «заявка, вызов, обращение». */
  readonly reason: RegExp;
  /** Просьба подойти — вариант «По частям». */
  readonly come: string;
  readonly comeRequires?: readonly Fact[];
}

/** Таблица сюжета в выборке банка (`callerPlots` bankPhrases.json, web.py). */
export interface CallerPlotSource {
  readonly reason: string;
  readonly come: string;
  readonly come_requires?: readonly Fact[];
  readonly facts: Readonly<
    Record<
      string,
      {
        readonly ask: string;
        readonly hear: string;
        readonly key?: boolean;
      }
    >
  >;
}

export function callerStory(source: CallerPlotSource): CallerStory {
  return {
    facts: Object.entries(source.facts).map(([fact, item]) => ({
      fact,
      ask: item.ask,
      hear: new RegExp(item.hear),
      key: item.key === true,
    })),
    reason: new RegExp(source.reason),
    come: source.come,
    comeRequires: source.come_requires,
  };
}

export type Ask =
  | { readonly kind: "fact"; readonly fact: Fact }
  /** Адрес прочитан вслух: дом и квартира, как их назвал диспетчер (`null` — не назвал). */
  | {
      readonly kind: "readback";
      readonly house: string | null;
      readonly flat: string | null;
    }
  /** Просьба подойти к бригаде. */
  | { readonly kind: "come" }
  | { readonly kind: "bye" }
  /** Вопрос не по сюжету — «не знаю». */
  | { readonly kind: "other" }
  /** «Повторите» — заявитель повторяет свою последнюю реплику. */
  | { readonly kind: "again" };

export interface Heard {
  /** Вопросы по порядку во фразе. */
  readonly asks: readonly Ask[];
  /** Диспетчер назвал службу. */
  readonly service: boolean;
  /** Диспетчер назвал повод звонка (заявка или слово повода сюжета). */
  readonly reason: boolean;
  /** «Да», «верно» — согласие на переспрос «Это из аварийной, что ли?». */
  readonly yes: boolean;
}

function norm(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е");
}

// Общее для всех сюжетов; вопросы о сведениях — из таблицы сюжета. Порядок не важен:
// вопросы во фразе упорядочиваются по месту в тексте.
const COMMON: readonly (readonly [Ask, RegExp])[] = [
  [
    { kind: "come" },
    /подойдите|подходите|приходите|идите к|спуститесь|откройте|откроете дверь|бригад\S* (ждет|ждут|стоит|стоят|у двери)/,
  ],
  [{ kind: "bye" }, /до свидания|всего доброго|всего хорошего/],
];

const SERVICE =
  /жкх|аварийн|диспетчер|служб|управляющ|коммунальн|ддс|сантехник/;
const REASON = /заявк|вызов|обращени/;
const YES = /^(да|так|верно|точно|ага|правильно)(?![а-я])/;
const AGAIN = /повторите|еще раз|не расслышал|не понял/;
// Вопросительное слово — вопрос даже в фразе со службой и поводом («Аварийная служба. Где
// котёнок?»); один знак «?» при названной службе — представление с переспросом («Аварийная
// служба, по заявке о котёнке?»): заявитель ждёт вопроса.
const QUESTION_WORD =
  /(?<![а-я])(что|как|какой|какая|сколько|где|когда|почему|кто|чей|ли)(?![а-я])/;
// Адрес вслух: число рядом с домом, квартирой или улицей. Границы слов — без `\b`: в JS
// он не знает кириллицы.
const ADDRESS_WORDS =
  /(?<![а-я])(дом|д\.|квартир|кв(?![а-я])|улиц|ул(?![а-я]))/;

/** Ответ на вопрос «по сюжету» есть в книге; что сверх сюжета — «не знаю». */
export function hear(text: string, story: CallerStory, street = ""): Heard {
  const said = norm(text);
  const found: { at: number; ask: Ask }[] = [];
  const patterns: (readonly [Ask, RegExp])[] = [
    ...COMMON,
    ...story.facts.map(
      ({ fact, hear: pattern }) =>
        [{ kind: "fact", fact } as Ask, pattern] as const,
    ),
  ];
  for (const [ask, pattern] of patterns) {
    const match = pattern.exec(said);
    if (match) found.push({ at: match.index, ask });
  }
  const numbers = numbersIn(said);
  const streetWord = norm(street).split(/\s+/)[0] ?? "";
  const addressSaid =
    ADDRESS_WORDS.test(said) ||
    (streetWord.length > 4 && said.includes(streetWord.slice(0, -2)));
  let asks = found.sort((a, b) => a.at - b.at).map((item) => item.ask);
  if (numbers.length > 0 && addressSaid) {
    const readback = readAddress(said, numbers);
    const at = asks.findIndex(
      (ask) => ask.kind === "fact" && ask.fact === "address",
    );
    // Адрес прочитан вслух — это не вопрос «назовите адрес».
    asks = asks.filter(
      (ask) => !(ask.kind === "fact" && ask.fact === "address"),
    );
    asks.splice(at < 0 ? 0 : at, 0, readback);
  }
  const service = SERVICE.test(said);
  const reason = REASON.test(said) || story.reason.test(said);
  if (asks.length === 0 && AGAIN.test(said)) asks = [{ kind: "again" }];
  // Вопрос не из таблицы — «не знаю»; слово повода в нём («Где котёнок?») не делает фразу
  // представлением.
  if (
    asks.length === 0 &&
    (QUESTION_WORD.test(said) || (said.includes("?") && !service))
  )
    asks = [{ kind: "other" }];
  return { asks, service, reason, yes: YES.test(said.trim()) };
}

interface Spoken {
  readonly value: number;
  readonly at: number;
}

const TEENS: Record<string, number> = {
  десять: 10,
  одиннадцать: 11,
  двенадцать: 12,
  тринадцать: 13,
  четырнадцать: 14,
  пятнадцать: 15,
  шестнадцать: 16,
  семнадцать: 17,
  восемнадцать: 18,
  девятнадцать: 19,
};
const TENS: readonly (readonly [RegExp, number])[] = [
  [/^двадцат/, 20],
  [/^тридцат/, 30],
  [/^сорок/, 40],
  [/^пят(ь|и)десят/, 50],
  [/^шест(ь|и)десят/, 60],
  [/^сем(ь|и)десят/, 70],
  [/^вос(емь|ьми)десят/, 80],
  [/^девяност/, 90],
];
const UNITS: readonly (readonly [RegExp, number])[] = [
  [/^(один|одна|одно|перв(ый|ая|ое|ого|ой|ую|ом|ому|ым|ые|ых|ыми))$/, 1],
  [/^(два|две|втор(ой|ая|ое|ого|ую|ом|ому|ым|ые|ых|ыми))$/, 2],
  [/^(три|трет(ий|ья|ье|ьего|ьей|ью|ьем|ьему|ьим|ьи|ьих|ьими))$/, 3],
  [/^(четыре|четверт(ый|ая|ое|ого|ой|ую|ом|ому|ым|ые|ых|ыми))$/, 4],
  [/^(пять|пят(ый|ая|ое|ого|ой|ую|ом))$/, 5],
  [/^(шесть|шест(ой|ая|ое|ого|ую|ом))$/, 6],
  [/^(семь|седьм(ой|ая|ое|ого|ую|ом|ому|ым|ые|ых|ыми))$/, 7],
  [/^(восемь|восьм(ой|ая|ое|ого|ую|ом|ому|ым|ые|ых|ыми))$/, 8],
  [/^(девять|девят(ый|ая|ое|ого|ой|ую|ом))$/, 9],
];

function unitOf(word: string): number | null {
  for (const [pattern, value] of UNITS) if (pattern.test(word)) return value;
  return null;
}

/** Числа во фразе по порядку: «22», «двадцать два», «пятьдесят восьмая». */
export function numbersIn(text: string): readonly Spoken[] {
  const found: Spoken[] = [];
  const words = [...norm(text).matchAll(/[0-9]+|[а-я]+/g)];
  for (let index = 0; index < words.length; index += 1) {
    const match = words[index]!;
    const word = match[0];
    if (/^[0-9]+$/.test(word)) {
      found.push({ value: Number(word), at: match.index });
      continue;
    }
    if (word in TEENS) {
      found.push({ value: TEENS[word]!, at: match.index });
      continue;
    }
    const tens = TENS.find(([pattern]) => pattern.test(word));
    if (tens) {
      const next = words[index + 1]?.[0] ?? "";
      const unit = unitOf(next);
      if (unit !== null) index += 1;
      found.push({ value: tens[1] + (unit ?? 0), at: match.index });
      continue;
    }
    const unit = unitOf(word);
    if (unit !== null) found.push({ value: unit, at: match.index });
  }
  return found;
}

/** Дом и квартира из прочитанного адреса: по словам «дом», «квартира», иначе по порядку. */
function readAddress(said: string, numbers: readonly Spoken[]): Ask {
  let house: number | null = null;
  let flat: number | null = null;
  const rest: Spoken[] = [];
  for (const number of numbers) {
    const before = said.slice(Math.max(0, number.at - 12), number.at);
    if (/(квартир\S*|кв\.?)\s*$/.test(before)) flat = number.value;
    else if (/(?<![а-я])(дом\S*|д\.?)\s*$/.test(before)) house = number.value;
    else rest.push(number);
  }
  for (const number of rest) {
    if (house === null) house = number.value;
    else if (flat === null) flat = number.value;
  }
  return {
    kind: "readback",
    house: house === null ? null : String(house),
    flat: flat === null ? null : String(flat),
  };
}
