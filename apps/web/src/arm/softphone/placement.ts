// Куда раскрывается панель телефона и какой она высоты. Правило одно: панель
// остаётся внутри видимой части карточки и прокручивается сама. Иначе открытие
// телефона прокручивает карточку — обучаемый теряет из виду происшествие.

/** Видимые границы области, за которые выходить нельзя. */
export interface Edge {
  readonly top: number;
  readonly bottom: number;
}

/** Полоса телефона, от которой панель раскрывается. */
export interface Anchor {
  readonly top: number;
  readonly bottom: number;
}

export interface Placement {
  /** Вверх — когда снизу места меньше. */
  readonly up: boolean;
  readonly maxHeight: number;
}

/** Зазор до края области и наименьшая полезная высота панели. */
export const PANEL_GAP = 8;
export const PANEL_MIN = 200;

export function placePanel(anchor: Anchor, edge: Edge): Placement {
  const below = edge.bottom - anchor.bottom - PANEL_GAP;
  const above = anchor.top - edge.top - PANEL_GAP;
  // Вниз — направление по умолчанию: наверх уходим, только если там просторнее.
  const up = below < above;
  return { up, maxHeight: Math.max(PANEL_MIN, up ? above : below) };
}

/**
 * Размер панели по месту. Вниз панель растёт от полосы и верх у неё не
 * двигается — хватает предела высоты. Вверх её низ прижат к полосе, и любой
 * рост содержимого (направили бригаду, пришёл доклад) толкал бы вверх всё, по
 * чему только что кликали. Поэтому вверх место занимается сразу целиком: верх
 * стоит у края области, содержимое растёт внутри вниз и прокручивается само.
 */
export function panelSize(place: Placement): {
  readonly height: number | null;
  readonly maxHeight: number;
} {
  return {
    height: place.up ? place.maxHeight : null,
    maxHeight: place.maxHeight,
  };
}

/**
 * Место под верхний блок панели (набор или разговор) только растёт, пока панель
 * открыта: разговор короче набора, и без запаса бригады под ним подпрыгивали бы
 * к кнопке «Позвонить», по которой только что нажали.
 */
export function reserveHeight(reserved: number, measured: number): number {
  return Math.max(reserved, Math.ceil(measured));
}

/** Ближайшая прокручиваемая область (карточка живёт в своей) или null — окно. */
export function scrollArea(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "hidden") {
      return parent;
    }
  }
  return null;
}

/**
 * Границы, за которые всплывающему нельзя вылезать: ближайшая прокручиваемая
 * область, пересечённая с экраном.
 */
export function limits(node: HTMLElement): Edge {
  const area = scrollArea(node);
  if (!area) return { top: 0, bottom: window.innerHeight };
  const box = area.getBoundingClientRect();
  return {
    top: Math.max(0, box.top),
    bottom: Math.min(window.innerHeight, box.bottom),
  };
}

/**
 * Следит, не сдвинулся ли якорь всплывающего. Под полосой телефона на ходу
 * появляются форма статуса и строка служб — полоса уезжает вверх, хотя её
 * размер не меняется. Поэтому смотрим на область и на всех её детей: сдвиг
 * любого из них меняет место под панель. Возвращает отписку.
 */
export function watchLayout(
  node: HTMLElement,
  onChange: () => void,
): () => void {
  const sizes = new ResizeObserver(onChange);
  sizes.observe(node);
  const area = scrollArea(node);
  const observeArea = () => {
    if (!area) return;
    sizes.observe(area);
    for (const child of Array.from(area.children)) sizes.observe(child);
  };
  observeArea();
  // Новый блок в области (появилась форма) тоже берём под наблюдение.
  const children = new MutationObserver(() => {
    observeArea();
    onChange();
  });
  if (area) children.observe(area, { childList: true });
  window.addEventListener("resize", onChange);
  // Прокрутка страницы или области тоже двигает якорь.
  window.addEventListener("scroll", onChange, true);
  return () => {
    sizes.disconnect();
    children.disconnect();
    window.removeEventListener("resize", onChange);
    window.removeEventListener("scroll", onChange, true);
  };
}
