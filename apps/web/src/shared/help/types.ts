export interface HelpTopic {
  title: string;
  text: string;
}
export interface HelpGuide {
  id: string;
  title: string;
  order: readonly string[];
  topics: Record<string, HelpTopic>;
}
