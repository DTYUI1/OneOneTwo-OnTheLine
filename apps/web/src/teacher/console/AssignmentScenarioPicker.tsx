import {
  type CSSProperties,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Participant, Scenario } from "./model";
import { matchesService } from "./handoutModel";
import styles from "./Console.module.css";
import picker from "./AssignmentScenarioPicker.module.css";

export function AssignmentScenarioPicker({
  scenarios,
  participant,
  serviceName,
  onChoose,
  disabled = false,
}: {
  scenarios: (Scenario & { displayTitle?: string; specifics?: string })[];
  disabled?: boolean;
  participant: Pick<Participant, "dds_service_id" | "workstation_number">;
  serviceName: (id: string) => string;
  onChoose: (scenario: Scenario) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState("date-desc");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<CSSProperties>({});
  const label = (scenario: (typeof scenarios)[number]) =>
    `${scenario.displayTitle ?? `№ ${scenario.card.number} · ${scenario.card.incident_class}`} · ${serviceName(scenario.target_service_id)} · ур. ${scenario.level}${scenario.specifics ? ` · ${scenario.specifics}` : ""}`;
  const matching = scenarios
    .filter((scenario) =>
      label(scenario)
        .toLocaleLowerCase("ru-RU")
        .includes(query.trim().toLocaleLowerCase("ru-RU")),
    )
    .sort((a, b) => {
      if (sort === "catalog") return 0;
      if (sort === "manual")
        return Number(Boolean(b.is_manual)) - Number(Boolean(a.is_manual));
      if (sort.startsWith("level"))
        return (a.level - b.level) * (sort === "level-asc" ? 1 : -1);
      const left = a.created_at ? Date.parse(a.created_at) : NaN;
      const right = b.created_at ? Date.parse(b.created_at) : NaN;
      if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : 0;
      if (!Number.isFinite(right)) return -1;
      return (left - right) * (sort === "date-asc" ? 1 : -1);
    });
  const own = matching.filter((scenario) =>
    matchesService(scenario, participant),
  );
  const other = matching.filter(
    (scenario) => !matchesService(scenario, participant),
  );
  const ordered = [...own, ...other];
  const choose = (scenario: Scenario) => {
    if (disabled) return;
    onChoose(scenario);
    setQuery("");
    setOpen(false);
    setActive(-1);
  };
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = input.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const upward = below < 160 && above > below;
      const maxHeight = Math.min(320, Math.max(80, upward ? above : below));
      setPosition({
        left: rect.left,
        width: rect.width,
        top: upward ? undefined : rect.bottom + 4,
        bottom: upward ? window.innerHeight - rect.top + 4 : undefined,
        maxHeight,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);
  useEffect(() => {
    if (open && active >= 0)
      document
        .getElementById(`${id}-${active}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, id]);
  return (
    <div className={styles.field}>
      <label htmlFor={id}>Добавить задание</label>
      <div className={picker.inputWrap}>
        <input
          ref={input}
          disabled={disabled}
          id={id}
          role="combobox"
          autoComplete="off"
          value={query}
          aria-expanded={open}
          aria-controls={open ? `${id}-list` : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            open && ordered[active] ? `${id}-${active}` : undefined
          }
          placeholder="Выберите сценарий или введите номер / название"
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={(event) => {
            if (!menu.current?.contains(event.relatedTarget as Node | null))
              setOpen(false);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActive((previous) =>
                ordered.length
                  ? (previous +
                      (event.key === "ArrowDown" ? 1 : previous < 0 ? 0 : -1) +
                      ordered.length) %
                    ordered.length
                  : -1,
              );
            } else if (event.key === "Enter" && open) {
              event.preventDefault();
              const selected = ordered[active >= 0 ? active : 0];
              if (selected) choose(selected);
            }
          }}
        />
        <span aria-hidden="true" className={picker.arrow}>
          ▾
        </span>
      </div>
      {open &&
        !disabled &&
        createPortal(
          <div
            ref={menu}
            className={picker.menu}
            style={position}
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                ) &&
                event.relatedTarget !== input.current
              )
                setOpen(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                input.current?.focus();
                setOpen(false);
              }
            }}
          >
            <label className={picker.sort}>
              Сортировка внутри служб
              <select
                value={sort}
                onChange={(event) => {
                  setSort(event.target.value);
                  setActive(-1);
                }}
              >
                <option value="catalog">Сначала новые ИИ-карточки</option>
                <option value="manual">Сначала ручные карточки</option>
                <option value="level-asc">Уровень: от 1 к 4</option>
                <option value="level-desc">Уровень: от 4 к 1</option>
                <option value="date-desc">
                  Дата добавления: сначала новые
                </option>
                <option value="date-asc">
                  Дата добавления: сначала старые
                </option>
              </select>
            </label>
            <div
              id={`${id}-list`}
              role="listbox"
              aria-label="Сценарии для добавления"
            >
              {[
                { title: "Своя служба", items: own, offset: 0 },
                {
                  title: "Чужая служба — упражнение на неверную доставку",
                  items: other,
                  offset: own.length,
                },
              ]
                .filter((group) => group.items.length)
                .map((group) => (
                  <div role="group" aria-label={group.title} key={group.title}>
                    <div className={picker.groupTitle}>{group.title}</div>
                    {group.items.map((scenario, index) => (
                      <button
                        type="button"
                        role="option"
                        value={scenario.id}
                        tabIndex={-1}
                        key={scenario.id}
                        id={`${id}-${group.offset + index}`}
                        aria-selected={active === group.offset + index}
                        className={picker.option}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => choose(scenario)}
                      >
                        {label(scenario)}
                      </button>
                    ))}
                  </div>
                ))}
              {!ordered.length && (
                <div className={picker.empty}>
                  Сценарии не найдены. Измените или очистите поиск.
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
