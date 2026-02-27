import { describe, expect, test, vi } from "vitest";
import type {
  ExperimentMetadataValues,
  ExperimentOptions,
  ExperimentOptionsWithVariant,
  ExperimentSelectFn,
  ExperimentStrategyConfig,
  GroupExperiment,
  VariantResult,
} from "../types.ts";
import { createGroupTools } from "./InngestGroupTools.ts";
import { experimentRunSymbol } from "./InngestStepTools.ts";

describe("Step Tool Wiring", () => {
  describe("experimentRunSymbol", () => {
    test("is a Symbol", () => {
      expect(typeof experimentRunSymbol).toBe("symbol");
    });
  });

  describe("createGroupTools()", () => {
    test("works without run tool (backward compat)", () => {
      const tools = createGroupTools();
      expect(tools).toHaveProperty("parallel");
      expect(typeof tools.parallel).toBe("function");
    });

    test("accepts run tool parameter and still returns parallel", () => {
      const mockRunTool = vi.fn().mockResolvedValue("mock-result");
      const tools = createGroupTools(mockRunTool);
      expect(tools).toHaveProperty("parallel");
      expect(typeof tools.parallel).toBe("function");
    });
  });
});

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

describe("experiment()", () => {
  const mockSelect = Object.assign(() => "control", {
    __experimentConfig: { strategy: "random" },
  }) as ExperimentSelectFn;

  test("basic variant selection and execution", async () => {
    const mockRunTool = vi.fn().mockResolvedValue("control");
    const tools = createGroupTools(mockRunTool);

    const result = await tools.experiment("my-exp", {
      variants: {
        control: () => "A",
        treatment: () => "B",
      },
      select: mockSelect,
    });

    expect(result).toBe("A");
  });

  test("withVariant: true returns { result, variant }", async () => {
    const mockRunTool = vi.fn().mockResolvedValue("control");
    const tools = createGroupTools(mockRunTool);

    const result = await tools.experiment("my-exp", {
      variants: {
        control: () => "A",
        treatment: () => "B",
      },
      select: mockSelect,
      withVariant: true,
    });

    expect(result).toEqual({ result: "A", variant: "control" });
  });

  test("without withVariant returns result directly", async () => {
    const mockRunTool = vi.fn().mockResolvedValue("treatment");
    const tools = createGroupTools(mockRunTool);

    const result = await tools.experiment("my-exp", {
      variants: {
        control: () => "A",
        treatment: () => "B",
      },
      select: mockSelect,
    });

    expect(result).toBe("B");
  });

  test("string ID parsing", async () => {
    const mockRunTool = vi.fn().mockResolvedValue("control");
    const tools = createGroupTools(mockRunTool);

    await tools.experiment("my-experiment", {
      variants: { control: () => "A" },
      select: mockSelect,
    });

    expect(mockRunTool).toHaveBeenCalledWith(
      { id: "my-experiment" },
      expect.any(Function),
    );
  });

  test("StepOptions object parsing", async () => {
    const mockRunTool = vi.fn().mockResolvedValue("control");
    const tools = createGroupTools(mockRunTool);

    await tools.experiment(
      { id: "my-exp", name: "My Experiment" },
      {
        variants: { control: () => "A" },
        select: mockSelect,
      },
    );

    expect(mockRunTool).toHaveBeenCalledWith(
      { id: "my-exp", name: "My Experiment" },
      expect.any(Function),
    );
  });

  test("invalid variant name from select throws error", async () => {
    const mockRunTool = vi.fn().mockResolvedValue("nonexistent");
    const tools = createGroupTools(mockRunTool);

    await expect(
      tools.experiment("my-exp", {
        variants: {
          control: () => "A",
          treatment: () => "B",
        },
        select: mockSelect,
      }),
    ).rejects.toThrow(/nonexistent/);

    await expect(
      tools.experiment("my-exp", {
        variants: {
          control: () => "A",
          treatment: () => "B",
        },
        select: mockSelect,
      }),
    ).rejects.toThrow(/control, treatment/);
  });

  test("empty variants record throws error", async () => {
    const mockRunTool = vi.fn().mockResolvedValue("any");
    const tools = createGroupTools(mockRunTool);

    await expect(
      tools.experiment("my-exp", {
        variants: {},
        select: mockSelect,
      }),
    ).rejects.toThrow(/at least one variant/);
  });

  test("async variant callback", async () => {
    const mockRunTool = vi.fn().mockResolvedValue("control");
    const tools = createGroupTools(mockRunTool);

    const result = await tools.experiment("my-exp", {
      variants: {
        control: async () => {
          return "async-result";
        },
      },
      select: mockSelect,
    });

    expect(result).toBe("async-result");
  });

  test("selection function passed through run tool", async () => {
    const mockRunTool = vi.fn().mockResolvedValue("control");
    const tools = createGroupTools(mockRunTool);

    await tools.experiment("my-exp", {
      variants: { control: () => "A" },
      select: mockSelect,
    });

    // The second arg to the run tool should be a function that calls select()
    const selectionFn = mockRunTool.mock.calls[0]![1] as () => unknown;
    expect(typeof selectionFn).toBe("function");

    const selectionResult = selectionFn();
    expect(selectionResult).toBe("control");
  });
});

describe("Integration: end-to-end experiment flow", () => {
  /**
   * Creates a run tool that simulates step.run memoization:
   * - First call for a step ID: executes the function and caches the result
   * - Subsequent calls for the same step ID: returns cached result without
   *   calling the function again
   */
  const createMemoizingRunTool = () => {
    const cache = new Map<string, unknown>();
    return vi.fn(async (...args: unknown[]) => {
      const stepOptions = args[0] as { id: string };
      const fn = args[1] as () => unknown;
      const key = stepOptions.id;
      if (cache.has(key)) {
        return cache.get(key);
      }
      const result = await fn();
      cache.set(key, result);
      return result;
    });
  };

  test("memoization: select function not re-invoked on repeated execution", async () => {
    const memoizingRun = createMemoizingRunTool();
    const tools = createGroupTools(memoizingRun);

    const selectSpy = vi.fn().mockReturnValue("control");
    const select = Object.assign(selectSpy, {
      __experimentConfig: { strategy: "random" },
    }) as ExperimentSelectFn;

    const variants = {
      control: () => "A",
      treatment: () => "B",
    };

    // First call — should invoke select
    const result1 = await tools.experiment("my-exp", { variants, select });
    expect(result1).toBe("A");
    expect(selectSpy).toHaveBeenCalledTimes(1);

    // Second call — memoized, select NOT called again
    const result2 = await tools.experiment("my-exp", { variants, select });
    expect(result2).toBe("A");
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  test("only the selected variant callback executes", async () => {
    const mockRunTool = vi.fn().mockResolvedValue("treatment");
    const tools = createGroupTools(mockRunTool);

    const mockSelect = Object.assign(() => "treatment", {
      __experimentConfig: {
        strategy: "weighted",
        weights: { control: 0.5, treatment: 0.5 },
      },
    }) as ExperimentSelectFn;

    const controlCallback = vi.fn().mockReturnValue(42);
    const treatmentCallback = vi.fn().mockReturnValue("hello");

    const result = await tools.experiment("flow-exp", {
      variants: {
        control: controlCallback,
        treatment: treatmentCallback,
      },
      select: mockSelect,
    });

    // Only the selected variant's callback was invoked
    expect(controlCallback).not.toHaveBeenCalled();
    expect(treatmentCallback).toHaveBeenCalledTimes(1);

    // Result is the selected variant's return value
    expect(result).toBe("hello");
  });

  test("withVariant wraps the selected variant result", async () => {
    const mockRunTool = vi.fn().mockResolvedValue("control");
    const tools = createGroupTools(mockRunTool);

    const mockSelect = Object.assign(() => "control", {
      __experimentConfig: { strategy: "random" },
    }) as ExperimentSelectFn;

    const result = await tools.experiment("wrapped-exp", {
      variants: {
        control: () => 42,
        treatment: () => "hello",
      },
      select: mockSelect,
      withVariant: true,
    });

    expect(result).toEqual({ result: 42, variant: "control" });
  });
});

describe("Integration: type compilation", () => {
  test("all experiment types compose correctly in a realistic scenario", () => {
    // Strategy config
    const config: ExperimentStrategyConfig = {
      strategy: "weighted",
      weights: { control: 0.7, treatment: 0.3 },
    };

    // Select function with embedded config
    const select = Object.assign(() => "control" as string, {
      __experimentConfig: config,
    }) as ExperimentSelectFn;

    // Typed variants with heterogeneous returns
    const variants = {
      control: () => 42 as number,
      treatment: () => "hello" as string,
    };

    // ExperimentOptions composes correctly
    const opts: ExperimentOptions<typeof variants> = { variants, select };
    expectTypeOf(opts.variants).toEqualTypeOf<typeof variants>();
    expectTypeOf(opts.select).toEqualTypeOf<ExperimentSelectFn>();

    // VariantResult infers union
    type Result = VariantResult<never, typeof variants>;
    expectTypeOf<Result>().toEqualTypeOf<number | string>();

    // GroupExperiment: default returns T
    const expFn = (() => {}) as unknown as GroupExperiment;
    const defaultResult = expFn("test", opts);
    expectTypeOf(defaultResult).toEqualTypeOf<Promise<number | string>>();

    // GroupExperiment: withVariant returns { result, variant }
    const withVariantOpts: ExperimentOptionsWithVariant<typeof variants> = {
      ...opts,
      withVariant: true,
    };
    const wrappedResult = expFn("test", withVariantOpts);
    expectTypeOf(wrappedResult).toEqualTypeOf<
      Promise<{ result: number | string; variant: string }>
    >();

    // ExperimentMetadataValues is structurally valid
    const metadata: ExperimentMetadataValues = {
      experiment_name: "test",
      variant_selected: "control",
      selection_strategy: config.strategy,
      available_variants: Object.keys(variants),
      variant_weights: config.weights,
    };
    expectTypeOf(metadata).toMatchTypeOf<ExperimentMetadataValues>();
  });
});
