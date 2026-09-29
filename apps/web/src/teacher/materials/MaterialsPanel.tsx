// Материалы преподавателя (D-03, C-07): загрузка PDF/DOCX/JSON/XML/CSV, каталог с
// назначением версии, новая версия поверх прежней. Справку обучаемому выдаёт
// назначение на занятии — см. SessionMaterials.
import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, csrfToken } from "../../shared/api";
import {
  ACCEPT,
  PURPOSE_LABELS,
  contentUrl,
  fileProblem,
  formatSize,
  latestVersions,
  mediaTypeFor,
  MEDIA_TYPES,
  type Material,
  type Purpose,
} from "./materialsModel";
import kit from "../console/Console.module.css";

export function useMaterials() {
  return useQuery({
    queryKey: ["materials"],
    queryFn: async () => {
      const { data, error, response } = await api.GET("/materials");
      if (!data)
        throw new Error(
          response.status === 501
            ? "Сервер пока не принимает материалы."
            : (error?.message ?? "Каталог материалов недоступен."),
        );
      return data;
    },
  });
}

export function MaterialsPanel() {
  const queries = useQueryClient();
  const materials = useMaterials();
  const input = useRef<HTMLInputElement>(null);
  const fileDescription = useId();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [purpose, setPurpose] = useState<Purpose>("reference");
  const [previous, setPrevious] = useState<Material | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  const problem = fileProblem(file);

  const upload = async () => {
    if (!file || problem || !title.trim()) return;
    setPending(true);
    setError("");
    setNotice("");
    const form = new FormData();
    // Тип задаём по расширению: сервер сверит его с содержимым файла (415 при расхождении).
    form.append(
      "file",
      new Blob([file], { type: mediaTypeFor(file.name) ?? file.type }),
      file.name,
    );
    form.append(
      "metadata",
      JSON.stringify({
        title: title.trim(),
        purpose,
        previous_id: previous?.id ?? null,
        previous_version: previous?.version ?? null,
      }),
    );
    try {
      const response = await fetch("/api/materials", {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRF-Token": csrfToken() },
        body: form,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(
          body?.message ??
            (response.status === 413
              ? "Файл больше 10 МиБ."
              : response.status === 415
                ? "Тип файла не поддерживается или не совпал с содержимым."
                : `Материал не загружен (ошибка ${response.status}).`),
        );
      }
      const saved = (await response.json()) as Material;
      setNotice(
        `Загружено: «${saved.title}», версия ${saved.version} — ${PURPOSE_LABELS[saved.purpose]}.`,
      );
      setFile(null);
      setTitle("");
      setPrevious(null);
      if (input.current) input.current.value = "";
      await queries.invalidateQueries({ queryKey: ["materials"] });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Материал не загружен.",
      );
    } finally {
      setPending(false);
    }
  };

  const catalog = latestVersions(materials.data ?? []);

  return (
    <section className={kit.view} aria-labelledby="materials-title">
      <header className={kit.titleBar}>
        <div>
          <h2 id="materials-title">Материалы</h2>
          <span className={kit.status_draft}>{catalog.length}</span>
        </div>
      </header>
      <div className={kit.tabBody}>
        <div className={kit.panel}>
          <h3 className={kit.panelTitle}>
            {previous
              ? `Новая версия: «${previous.title}»`
              : "Загрузить материал"}
          </h3>
          <div className={kit.actions}>
            <div className={kit.field}>
              <span id={fileDescription}>
                Документ, таблица или файл данных (до 10 МиБ)
              </span>
              <input
                ref={input}
                type="file"
                hidden
                aria-label="Файл материала"
                accept={ACCEPT}
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  setFile(next);
                  if (next && !title)
                    setTitle(next.name.replace(/\.[^.]+$/, ""));
                }}
              />
              <button
                type="button"
                className={kit.plain}
                aria-describedby={fileDescription}
                onClick={() => input.current?.click()}
              >
                Выбрать файл
              </button>
              <span role="status">{file?.name ?? "Файл не выбран"}</span>
            </div>
            <label className={kit.field}>
              Название
              <input
                value={title}
                maxLength={300}
                className={kit.wide}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label className={kit.field}>
              Назначение
              <select
                value={purpose}
                disabled={Boolean(previous)}
                onChange={(event) => setPurpose(event.target.value as Purpose)}
              >
                <option value="reference">{PURPOSE_LABELS.reference}</option>
                <option value="evaluation">{PURPOSE_LABELS.evaluation}</option>
              </select>
            </label>
            <button
              type="button"
              className={kit.primary}
              disabled={pending || Boolean(problem) || !title.trim()}
              onClick={() => void upload()}
            >
              {pending ? "Загружаем…" : "Загрузить"}
            </button>
            {previous && (
              <button
                type="button"
                className={kit.plain}
                onClick={() => setPrevious(null)}
              >
                Отменить новую версию
              </button>
            )}
          </div>
          {file && problem && <p className={kit.problems}>{problem}</p>}
          <p className={kit.hint}>
            Справка видна обучаемому только после назначения на занятие;
            материалы для оценивания обучаемому не выдаются.
          </p>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
        </div>

        <div className={kit.panel}>
          <h3 className={kit.panelTitle}>Каталог</h3>
          {materials.isPending && <p>Загружаем каталог…</p>}
          {materials.isError && <p role="alert">{materials.error.message}</p>}
          {materials.data && catalog.length === 0 && (
            <p>Материалов пока нет.</p>
          )}
          {catalog.length > 0 && (
            <table className={kit.table}>
              <thead>
                <tr>
                  <th>Название</th>
                  <th>Назначение</th>
                  <th>Тип</th>
                  <th>Размер</th>
                  <th>Версия</th>
                  <th aria-label="Действия" />
                </tr>
              </thead>
              <tbody>
                {catalog.map((material) => (
                  <tr key={material.id}>
                    <td>
                      <strong>{material.title}</strong>
                    </td>
                    <td>{PURPOSE_LABELS[material.purpose]}</td>
                    <td>
                      {MEDIA_TYPES[material.media_type]?.label ??
                        material.media_type}
                    </td>
                    <td>{formatSize(material.size_bytes)}</td>
                    <td>
                      {material.version}
                      {material.versions > 1 && (
                        <span className={kit.muted}>
                          {" "}
                          (версий: {material.versions})
                        </span>
                      )}
                    </td>
                    <td className={kit.rowActions}>
                      <a
                        className={kit.plain}
                        href={contentUrl(material)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Открыть
                      </a>
                      <button
                        type="button"
                        className={kit.plain}
                        onClick={() => {
                          setPrevious(material);
                          setTitle(material.title);
                          setPurpose(material.purpose);
                          window.scrollTo({ top: 0 });
                        }}
                      >
                        Новая версия
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
