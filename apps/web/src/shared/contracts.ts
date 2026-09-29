/** Общие C-01 типы. Данные фикстур не подключаются к runtime API. */
import type { components } from "../api-client/schema";

type Schemas = components["schemas"];
export type TimingPolicy = Schemas["TimingPolicy"];
export type TimingInput = Schemas["TimingInput"];
export type TimingResult = Schemas["TimingResult"];
export type TimingFixture = Schemas["TimingFixture"];
export type TimingCalculator = (input: TimingInput) => TimingResult;
export type AssignmentBatchInput = Schemas["AssignmentBatchInput"];
export type AssignmentBatch = Schemas["AssignmentBatch"];
export type SessionLifecycle = Schemas["SessionLifecycle"];
export type Brigade = Schemas["Brigade"];
export type CallTarget = Schemas["CallTarget"];
export type CardTraining = Schemas["CardTraining"];
export type AttemptAnalysis = Schemas["AttemptAnalysis"];
export type SessionAnalytics = Schemas["SessionAnalytics"];
export type PredictionContext = Schemas["PredictionContext"];
export type CalibrationObservation = Schemas["CalibrationObservation"];
export type ScenarioPreview = Schemas["ScenarioPreview"];
export type ScenarioConstructor = Schemas["ScenarioConstructor"];
export type GenerateInput = Schemas["GenerateInput"];
export type GenerateOptions = Schemas["GenerateOptions"];
export type Material = Schemas["Material"];
