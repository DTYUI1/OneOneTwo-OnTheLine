// Тот же небольшой разбор, что в evalcore.service_told: словоформы и правила
// экспортируются из одного JSON. Проверка реального звонка и срока остаётся в newsService.
import language from "./serviceLanguage.json";

type State = "called" | "calling" | "denied";
interface Claim {
  readonly services: string[];
  readonly state: State;
  readonly named: boolean;
}
export interface ServiceIntent {
  readonly claims: Claim[];
  readonly services: string[];
  readonly called: boolean;
  readonly option: "already" | "calling" | null;
}

type Phrase = readonly string[];
const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/ё/g, "е")
    .match(new RegExp(language.token_pattern, "g")) ?? [];
const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const phrases = (values: readonly string[]): Phrase[] =>
  [...new Set(values.map((value) => tokens(value).join("\0")))]
    .map((value) => value.split("\0"))
    .sort((a, b) => b.length - a.length || lexical(a.join("\0"), b.join("\0")));
const matches = (
  words: readonly string[],
  at: number,
  phrase: Phrase,
): boolean => phrase.every((word, index) => words[at + index] === word);
const services = Object.entries(language.services).map(([ext, forms]) => ({
  ext,
  forms: phrases(forms),
}));
const predicates = (["called", "calling", "denied"] as const)
  .flatMap((state) =>
    phrases(language.predicates[state]).map((phrase) => ({ phrase, state })),
  )
  .sort(
    (a, b) =>
      b.phrase.length - a.phrase.length ||
      lexical(a.phrase.join("\0"), b.phrase.join("\0")),
  );
const modality = phrases(language.modality);
const questionHeads = phrases(language.question_heads);
const aliases: Readonly<Record<string, string>> = language.aliases;
const expected = (exts: readonly string[]): string[] =>
  [...new Set(exts.map((ext) => aliases[ext] ?? ext))]
    .filter((ext) => services.some((service) => service.ext === ext))
    .sort();

function* clauses(text: string): Generator<string[]> {
  for (const sentence of text.matchAll(/([^.!?;\n]+)([.!?;\n]*)/g)) {
    const words = tokens(sentence[1]);
    if (
      sentence[2].includes("?") ||
      questionHeads.some((phrase) => matches(words, 0, phrase))
    )
      continue;
    for (const part of sentence[1].split(",")) {
      let current: string[] = [];
      for (const word of tokens(part)) {
        if (language.clause_breaks.includes(word)) {
          if (current.length) yield current;
          current = [];
        } else current.push(word);
      }
      if (current.length) yield current;
    }
  }
}

export function parseServiceIntent(
  text: string,
  exts: readonly string[] = [],
): ServiceIntent {
  const wanted = expected(exts);
  const claims: Claim[] = [];
  let inherited: string[] = [];
  for (const words of clauses(text)) {
    if (
      words.some((_, at) =>
        modality.some((phrase) => matches(words, at, phrase)),
      )
    )
      continue;
    let mentions: { start: number; end: number; ext: string }[] = [];
    for (const service of services) {
      for (let at = 0; at < words.length; ) {
        const phrase = service.forms.find((candidate) =>
          matches(words, at, candidate),
        );
        if (phrase) {
          mentions.push({
            start: at,
            end: at + phrase.length,
            ext: service.ext,
          });
          at += phrase.length;
        } else at++;
      }
    }
    // Длинное название «участковый врач» не является полицией.
    mentions = mentions.filter(
      (mention) =>
        !mentions.some(
          (other) =>
            other.start <= mention.start &&
            mention.end <= other.end &&
            other.end - other.start > mention.end - mention.start,
        ),
    );
    mentions.sort(
      (a, b) => a.start - b.start || a.end - b.end || lexical(a.ext, b.ext),
    );
    let previousEnd = 0;
    for (let at = 0; at < words.length; ) {
      const predicate = predicates.find((candidate) =>
        matches(words, at, candidate.phrase),
      );
      if (!predicate) {
        at++;
        continue;
      }
      const end = at + predicate.phrase.length;
      // Отрицание отмены сохраняет предыдущее состояние вызова.
      if (
        predicate.state === "denied" &&
        words
          .slice(previousEnd, at)
          .some((word) => language.negation.includes(word))
      ) {
        previousEnd = end;
        at = end;
        continue;
      }
      let targets: string[];
      let named: boolean;
      let state: State = predicate.state;
      if (mentions.length) {
        const distance = (mention: (typeof mentions)[number]) =>
          Math.max(mention.start - end, at - mention.end, 0);
        const nearest = [...mentions].sort(
          (a, b) => distance(a) - distance(b) || a.start - b.start,
        )[0];
        targets = [
          ...new Set(
            mentions
              .filter((mention) => {
                const ordered = [nearest, mention].sort(
                  (a, b) =>
                    a.start - b.start || a.end - b.end || lexical(a.ext, b.ext),
                );
                return words
                  .slice(ordered[0].end, ordered[1].start)
                  .every((word) => word === "и" || word === "или");
              })
              .map((mention) => mention.ext),
          ),
        ].sort();
        named = true;
        // «Вызвал не пожарных»: не подтверждаем отрицаемого адресата.
        // Эллипсис «а скорую» без своего предиката остаётся неподтверждённым.
        if (
          words
            .slice(end, nearest.start)
            .some((word) => language.negation.includes(word))
        )
          state = "denied";
      } else if (inherited.length) {
        targets = [...inherited];
        named = true;
      } else {
        targets = wanted.length === 1 ? [...wanted] : [];
        named = false;
      }
      if (
        words
          .slice(previousEnd, at)
          .some((word) => language.negation.includes(word))
      )
        state = "denied";
      claims.push({ services: targets, state, named });
      previousEnd = end;
      at = end;
    }
    if (mentions.length)
      inherited = [...new Set(mentions.map((mention) => mention.ext))].sort();
  }
  const final = new Map<string, Claim>();
  for (const claim of claims)
    for (const ext of claim.services.length ? claim.services : [""])
      final.set(ext, claim);
  const selected = [...final].filter(
    ([ext]) => !exts.length || wanted.includes(ext),
  );
  const called = selected.some(([, claim]) => claim.state === "called");
  return {
    claims,
    services: [...final]
      .filter(([ext, claim]) => ext !== "" && claim.state === "called")
      .map(([ext]) => ext)
      .sort(),
    called,
    option: called
      ? "already"
      : selected.some(([, claim]) => claim.state === "calling")
        ? "calling"
        : null,
  };
}
