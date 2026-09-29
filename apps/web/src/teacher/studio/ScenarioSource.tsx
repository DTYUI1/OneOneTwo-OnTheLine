import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api";
import { provenanceLines } from "./provenanceModel";

/** Источник задания и происхождение эталона — для преподавателя, не для ученика. */
export function ScenarioSource({
  scenarioId,
  className,
}: {
  scenarioId: string;
  className?: string;
}) {
  const content = useQuery({
    queryKey: ["scenario-content", scenarioId],
    queryFn: async () => {
      const { data } = await api.GET("/scenarios/{id}/content", {
        params: { path: { id: scenarioId } },
      });
      return data ?? null;
    },
    staleTime: 60_000,
  });
  if (content.isPending) return null;
  if (!content.data)
    return <p className={className}>Источник задания: не удалось получить.</p>;
  return (
    <p className={className}>
      {provenanceLines(content.data).map((line, index) => (
        <span key={line.label}>
          {index > 0 && <br />}
          {line.label}: {line.value}
        </span>
      ))}
    </p>
  );
}
