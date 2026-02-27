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
