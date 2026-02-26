import { describe, test } from "vitest";
import type {
  ExperimentMetadataValues,
  ExperimentOptions,
  ExperimentOptionsWithVariant,
  ExperimentSelectFn,
  ExperimentStrategyConfig,
  GroupExperiment,
  VariantResult,
} from "../types.ts";

describe("Experiment Types", () => {
  describe("VariantResult", () => {
    test("infers union from heterogeneous variants", () => {
      type Variants = { a: () => number; b: () => string };
      type Result = VariantResult<never, Variants>;

      expectTypeOf<Result>().toEqualTypeOf<number | string>();
    });

    test("infers shared type from homogeneous variants", () => {
      type Variants = { a: () => number; b: () => number };
      type Result = VariantResult<never, Variants>;

      expectTypeOf<Result>().toEqualTypeOf<number>();
    });

    test("returns TConstraint when not never", () => {
      type Variants = { a: () => number; b: () => string };
      type Result = VariantResult<boolean, Variants>;

      expectTypeOf<Result>().toEqualTypeOf<boolean>();
    });
  });

  describe("GroupExperiment", () => {
    test("withVariant returns { result: T, variant: string }", () => {
      type Variants = { a: () => number; b: () => string };
      type Opts = ExperimentOptionsWithVariant<Variants>;

      // Use Parameters/ReturnType on the overloaded type to check the withVariant overload
      const fn = (() => {}) as unknown as GroupExperiment;
      const result = fn("test", {} as Opts);

      expectTypeOf(result).toEqualTypeOf<
        Promise<{ result: number | string; variant: string }>
      >();
    });

    test("default returns T directly", () => {
      type Variants = { a: () => number; b: () => string };
      type Opts = ExperimentOptions<Variants>;

      const fn = (() => {}) as unknown as GroupExperiment;
      const result = fn("test", {} as Opts);

      expectTypeOf(result).toEqualTypeOf<Promise<number | string>>();
    });
  });

  describe("ExperimentSelectFn", () => {
    test("is callable with __experimentConfig property", () => {
      // Must be callable returning Promise<string> | string
      expectTypeOf<globalThis.ReturnType<ExperimentSelectFn>>().toEqualTypeOf<
        Promise<string> | string
      >();

      // Must have __experimentConfig property
      expectTypeOf<
        ExperimentSelectFn["__experimentConfig"]
      >().toEqualTypeOf<ExperimentStrategyConfig>();
    });
  });

  describe("ExperimentOptions", () => {
    test("requires both variants and select", () => {
      type Variants = { a: () => number };
      type Opts = ExperimentOptions<Variants>;

      expectTypeOf<Opts["variants"]>().toEqualTypeOf<Variants>();
      expectTypeOf<Opts["select"]>().toEqualTypeOf<ExperimentSelectFn>();
    });
  });

  describe("ExperimentStrategyConfig", () => {
    test("has strategy and optional weights", () => {
      expectTypeOf<ExperimentStrategyConfig>().toEqualTypeOf<{
        strategy: string;
        weights?: Record<string, number>;
      }>();
    });
  });

  describe("ExperimentMetadataValues", () => {
    test("has required metadata fields", () => {
      expectTypeOf<ExperimentMetadataValues>().toEqualTypeOf<{
        experiment_name: string;
        variant_selected: string;
        selection_strategy: string;
        available_variants: string[];
        variant_weights?: Record<string, number>;
      }>();
    });
  });
});
