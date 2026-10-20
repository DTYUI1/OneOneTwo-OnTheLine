export interface HelpTopic {
  title: string;
  text: string;
  /** Откуда взято: «Памятка ДДС, с. 21.» или «В памятке ДДС этого нет…» (GP-23). */
  memo?: string;
  table?: { headings: readonly string[]; rows: readonly (readonly string[])[] };
}
export interface HelpGuide {
  id: string;
  title: string;
  order: readonly string[];
  topics: Record<string, HelpTopic>;
  /**
   * Пройти этот экран с наставником (arm/tour): кнопка в панели объяснения закрывает его и
   * начинает обучение по интерфейсу. Только у экранов, где оно есть.
   */
  tour?: {
    readonly label: string;
    readonly start: () => void;
    /** Картинка на кнопке — портрет наставника: кнопку видно сразу. */
    readonly icon?: string;
  };
}
