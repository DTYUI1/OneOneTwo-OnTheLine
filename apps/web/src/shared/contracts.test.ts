import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, expectTypeOf, it } from "vitest";
import schema from "../../../../contracts/c01.schema.json";
import fixtureData from "../../../../contracts/examples/timing-v2.json";
import fixtureV3Data from "../../../../contracts/examples/timing-v3.json";
import examples from "../../../../contracts/examples/c01.json";
import openapi from "../../../../contracts/openapi.json";
import type { operations } from "../api-client/schema";
import type {
  CalibrationObservation,
  GenerateInput,
  GenerateOptions,
  Material,
  PredictionContext,
  TimingFixture,
  TimingPolicy,
  TimingResult,
} from "./contracts";

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema(schema);
ajv.addSchema(openapi, "https://arm112.local/contracts/openapi.json");
const validate = ajv.compile<TimingFixture>({
  $ref: `${schema.$id}#/$defs/TimingFixture`,
});

describe("Общий контракт времени C-01", () => {
  it.each(fixtureData)("$name: Python/TS читают один формат", (value) => {
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    if (!validate(value)) throw new Error("Неверная фикстура");
    // Проверяется смысл фикстур и знака часов, а не ещё не написанный V-01.
    for (const evidence of value.expected.evidence) {
      if (evidence.source !== "corrected_client") continue;
      const event = value.input.events.find(
        (item) => item.event_id === evidence.event_id,
      );
      if (!event?.clock) throw new Error("Нет измерения часов");
      expect(
        Date.parse(event.client_ts) + (event.clock.offset_ms ?? Number.NaN),
      ).toBe(Date.parse(evidence.normalized_at));
    }
  });

  it("сохраняет 20/170 и различает отсутствующее время и ноль", () => {
    const byName = (name: string) =>
      fixtureData.find((item) => item.name === name)?.expected;
    expect(byName("base_0_20_40_190")?.reaction_s).toBe(20);
    expect(byName("base_0_20_40_190")?.handling_s).toBe(170);
    expect(byName("zero_is_not_missing")?.reaction_s).toBe(0);
    expect(byName("no_open")?.reaction_s).toBeNull();
    expect(byName("negative_offset_buffer_30")?.handling_s).toBe(170);
    expect(byName("rejected_then_redirect")?.handling_s).toBe(170);
    expect(byName("legacy_rejected_boundary")?.handling_s).toBe(20);
  });

  it("отклоняет неизвестное поле, отрицательное время и отсутствующий null", () => {
    const base = fixtureData[0];
    expect(validate({ ...base, typo: 1 })).toBe(false);
    expect(
      validate({ ...base, expected: { ...base.expected, reaction_s: -1 } }),
    ).toBe(false);
    const missing: Record<string, unknown> = { ...base.expected };
    delete missing.reaction_s;
    expect(validate({ ...base, expected: missing })).toBe(false);
  });
});

describe("I-TIME v3: реакция до первичного статуса и активная обработка", () => {
  const byName = (name: string) =>
    fixtureV3Data.find((item) => item.name === name)?.expected;

  it.each(fixtureV3Data)("$name: соответствует общей схеме", (value) => {
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(value.input.policy?.timing_version).toBe(3);
  });

  it("даёт согласованные 40/170 и 110 при ожидании 60", () => {
    expect(byName("v3_base_0_20_40_190")?.reaction_s).toBe(40);
    expect(byName("v3_base_0_20_40_190")?.handling_s).toBe(170);
    expect(byName("v3_base_0_20_40_190")?.active_handling_s).toBe(170);
    expect(byName("v3_waiting_60")?.active_handling_s).toBe(110);
    expect(byName("v3_waiting_unknown")?.handling_overdue).toBeNull();
    expect(byName("v3_missing_direct")?.reaction_s).toBeNull();
  });
});

it("примеры всех пяти интерфейсов соответствуют общему JSON-контракту", () => {
  for (const [name, value] of Object.entries(examples)) {
    const check = ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` });
    expect(check(value), `${name}: ${JSON.stringify(check.errors)}`).toBe(true);
  }
});

describe("Ключ повтора генерации C-01", () => {
  const check = ajv.compile<GenerateInput>({
    $ref: "https://arm112.local/contracts/openapi.json#/components/schemas/GenerateInput",
  });
  const legacy: GenerateInput = {
    count: 10,
    level: 1,
    service_id: "102",
    seed: 42,
  };
  const options: GenerateOptions = {
    request_id: examples.GenerateOptions.request_id,
    selection: {
      author_kinds: ["system", "teacher"],
      incident_type_codes: ["2020000"],
      scenario_ids: [],
    },
    constructor: null,
  };

  it("сохраняет старый ввод и принимает UUID в options", () => {
    expectTypeOf<Pick<GenerateOptions, "request_id">>().toEqualTypeOf<{
      request_id: string;
    }>();
    expect(check(legacy)).toBe(true);
    const body: GenerateInput = { ...legacy, options };
    expect(check(body)).toBe(true);
    expect(check(JSON.parse(JSON.stringify(body)))).toBe(true);
    expect(check({ ...legacy, options: null })).toBe(true);
  });

  it.each([undefined, null, "", "wrong", 42])(
    "отклоняет отсутствующий или невалидный ключ: %s",
    (request_id) => {
      const input = JSON.parse(JSON.stringify({ ...options, request_id }));
      expect(check({ ...legacy, options: input })).toBe(false);
    },
  );

  it("не принимает ключ в корне запроса", () => {
    expect(check({ ...legacy, request_id: options.request_id })).toBe(false);
    expect(check({ ...legacy, options, request_id: options.request_id })).toBe(
      false,
    );
  });
});

describe("Назначение материалов C-01", () => {
  const check = ajv.compile<Material>({
    $ref: `${schema.$id}#/$defs/Material`,
  });
  const checkList = ajv.compile<Material[]>({
    $ref: "https://arm112.local/contracts/openapi.json#/paths/~1materials/get/responses/200/content/application~1json/schema",
  });

  it("предоставляет обязательный purpose во всех трёх ответах", () => {
    type Listed =
      operations["listMaterials"]["responses"][200]["content"]["application/json"];
    type Uploaded =
      operations["uploadMaterial"]["responses"][201]["content"]["application/json"];
    type Assigned =
      operations["assignMaterials"]["responses"][200]["content"]["application/json"];
    type Metadata =
      operations["uploadMaterial"]["requestBody"]["content"]["multipart/form-data"]["metadata"];
    expectTypeOf<Pick<Material, "purpose">>().toEqualTypeOf<{
      purpose: "reference" | "evaluation";
    }>();
    expectTypeOf<Listed>().toEqualTypeOf<Material[]>();
    expectTypeOf<Uploaded>().toEqualTypeOf<Material>();
    expectTypeOf<Assigned>().toEqualTypeOf<Material[]>();
    expectTypeOf<Metadata["purpose"]>().toEqualTypeOf<Material["purpose"]>();
  });

  it.each(["reference", "evaluation"] as const)(
    "принимает материал с назначением %s",
    (purpose) => {
      const value: Material = {
        ...examples.Material,
        purpose,
        media_type: "application/pdf",
      };
      expect(check(value), JSON.stringify(check.errors)).toBe(true);
    },
  );

  it.each([undefined, null, "", "unknown", 42])(
    "отклоняет отсутствующее или неизвестное назначение: %s",
    (purpose) => {
      const value = JSON.parse(
        JSON.stringify({ ...examples.Material, purpose }),
      );
      expect(check(value)).toBe(false);
      expect(checkList([value])).toBe(false);
    },
  );

  it("сохраняет оба назначения при повторном чтении примера каталога", () => {
    const content =
      openapi.paths["/materials"].get.responses["200"].content[
        "application/json"
      ];
    // Проверяется форма ответа; хранение, reload UI и права на материалы остаются C-07/D-03.
    const restored: unknown = JSON.parse(JSON.stringify(content.example));
    expect(checkList(restored), JSON.stringify(checkList.errors)).toBe(true);
    if (!checkList(restored))
      throw new Error("Неверный пример каталога материалов");
    expect(restored.map((item) => item.purpose)).toEqual([
      "reference",
      "evaluation",
    ]);
    expect(restored).toEqual(content.example);
    expect(restored.filter((item) => item.purpose === "reference")).toEqual([
      examples.Material,
    ]);
  });
});

describe("Норматив прогноза C-01", () => {
  const checkContext = ajv.compile<PredictionContext>({
    $ref: `${schema.$id}#/$defs/PredictionContext`,
  });
  const checkHistory = ajv.compile<CalibrationObservation>({
    $ref: `${schema.$id}#/$defs/CalibrationObservation`,
  });

  it("представляет нормативы 100/180 отдельными snapshot-контекстами", () => {
    expectTypeOf<PredictionContext["policy"]>().toEqualTypeOf<TimingPolicy>();
    expectTypeOf<PredictionContext["contract_version"]>().toEqualTypeOf<2>();
    const contexts = schema.$defs.PredictionContext.examples;
    for (const value of contexts) {
      expect(checkContext(value), JSON.stringify(checkContext.errors)).toBe(
        true,
      );
    }
    expect(contexts.map((value) => value.policy.handling_normative_s)).toEqual([
      100, 180,
    ]);
    expect(contexts[0].snapshot_id).not.toBe(contexts[1].snapshot_id);
  });

  it.each([0, -1, null, true, "180"])(
    "отклоняет недопустимый норматив: %s",
    (handling_normative_s) => {
      const value = examples.PredictionContext;
      expect(
        checkContext({
          ...value,
          policy: { ...value.policy, handling_normative_s },
        }),
      ).toBe(false);
    },
  );

  it("различает собственный норматив истории, качество и неизвестность", () => {
    expectTypeOf<CalibrationObservation["timing_quality"]>().toEqualTypeOf<
      TimingResult["quality"] | null
    >();
    const history = schema.$defs.CalibrationObservation.examples;
    for (const value of history) {
      expect(checkHistory(value), JSON.stringify(checkHistory.errors)).toBe(
        true,
      );
    }
    expect(history.map((value) => value.handling_normative_s)).toEqual([
      100,
      180,
      null,
    ]);
    expect(history.map((value) => value.timing_quality)).toEqual([
      "verified",
      "estimated",
      null,
    ]);
    expect(history[2].snapshot_id).toBeNull();
    for (const handling_s of [0, null]) {
      expect(
        checkHistory({ ...examples.CalibrationObservation, handling_s }),
      ).toBe(true);
    }
  });

  it("требует явный null вместо пропуска исторических полей", () => {
    for (const field of [
      "snapshot_id",
      "handling_normative_s",
      "timing_quality",
    ]) {
      const value: Record<string, unknown> = {
        ...examples.CalibrationObservation,
      };
      value[field] = null;
      expect(checkHistory(value)).toBe(true);
      delete value[field];
      expect(checkHistory(value)).toBe(false);
    }
  });
});
