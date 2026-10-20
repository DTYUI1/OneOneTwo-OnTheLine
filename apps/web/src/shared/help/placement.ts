export type Box = { left: number; top: number; width: number; height: number };
export type Point = { left: number; top: number };

/** Размер номера части вместе с рамкой, px. */
export const MARKER_SIZE = 26;
const GAP = 4;
const STEP = 4;

function overlaps(a: Box, b: Box) {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

/**
 * Номер не должен закрывать надписи, поля и другие номера. Порядок мест:
 * на левом верхнем углу рамки, в верхней полосе части правее заголовка,
 * слева снаружи, над частью. Если свободного места нет — внутри угла, как раньше.
 */
export function placeMarkers(
  parts: readonly Box[],
  obstacles: readonly Box[],
  viewport: { width: number; height: number },
): Point[] {
  const size = MARKER_SIZE;
  const taken: Box[] = [];
  const free = (left: number, top: number) => {
    const box = { left, top, width: size, height: size };
    return (
      left >= 0 &&
      top >= 0 &&
      left + size <= viewport.width &&
      top + size <= viewport.height &&
      !obstacles.some((o) => overlaps(box, o)) &&
      !taken.some((o) => overlaps(box, o))
    );
  };
  const row = function* (top: number, from: number, to: number) {
    for (let left = from; left + size <= to; left += STEP) yield { left, top };
  };
  return parts.map((part) => {
    const right = part.left + part.width;
    const candidates = function* () {
      yield {
        left: Math.max(0, part.left - size / 2),
        top: Math.max(0, part.top - size / 2),
      };
      yield* row(part.top + GAP, part.left + GAP, right - GAP);
      yield { left: part.left - size - GAP, top: part.top + GAP };
      yield* row(part.top - size - GAP, part.left, right);
    };
    let place = { left: part.left + 2, top: part.top + 2 };
    for (const candidate of candidates())
      if (free(candidate.left, candidate.top)) {
        place = candidate;
        break;
      }
    taken.push({ ...place, width: size, height: size });
    return place;
  });
}

export type Corner = "bottom-right" | "bottom-left" | "top-right" | "top-left";

/** Порядок углов: правый нижний — привычное место панели, остальные — если он занят. */
const CORNERS: readonly Corner[] = [
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
];

function overlapArea(a: Box, b: Box) {
  const width =
    Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height =
    Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Угол экрана для панели объяснения. Окна вроде телефона ДДС открываются в правом нижнем
 * углу и двигаются куда угодно: панель в постоянном углу закрывала бы ту самую часть,
 * которую объясняет. Берём угол, где панель меньше всего закрывает выбранную часть.
 */
export function bubbleCorner(
  part: Box,
  bubble: { width: number; height: number },
  viewport: { width: number; height: number },
  margin: number,
): Corner {
  const place = (corner: Corner): Box => ({
    left: corner.endsWith("left")
      ? margin
      : viewport.width - margin - bubble.width,
    top: corner.startsWith("top")
      ? margin
      : viewport.height - margin - bubble.height,
    width: bubble.width,
    height: bubble.height,
  });
  let best = CORNERS[0];
  let least = Infinity;
  for (const corner of CORNERS) {
    const area = overlapArea(place(corner), part);
    if (area < least) {
      best = corner;
      least = area;
    }
  }
  return best;
}
