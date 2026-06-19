import { describe, it, expect } from "vitest";
import type { GeminiAiAdapter } from "../../src/adapters/gemini";

// Helper: Validate Gemini 3 Pro functionCall thoughtSignature logic
function validateFunctionCallSignatures(parts: GeminiAiAdapter.Part[]) {
  let foundFirstFunctionCall = false;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // Type guard for FunctionCallPart
    if ("functionCall" in part && part.functionCall) {
      if (!foundFirstFunctionCall) {
        foundFirstFunctionCall = true;
        expect("thoughtSignature" in part).toBe(true);
        expect(typeof (part as any).thoughtSignature).toBe("string");
        expect((part as any).thoughtSignature?.length).toBeGreaterThan(0);
      } else {
        // Subsequent parallel functionCalls: signature is optional
        expect(
          !("thoughtSignature" in part) || (part as any).thoughtSignature === undefined || typeof (part as any).thoughtSignature === "string"
        ).toBe(true);
      }
    }
  }
}

describe("Gemini 3 Pro functionCall thoughtSignature logic", () => {
  it("validates sequential function calls (all signatures required)", () => {
    const parts: GeminiAiAdapter.Part[] = [
      {
        functionCall: { name: "check_flight", args: { flight: "AA100" } },
        thoughtSignature: "sig-A"
      },
      {
        functionCall: { name: "book_taxi", args: { time: "10 AM" } },
        thoughtSignature: "sig-B"
      }
    ];
    validateFunctionCallSignatures(parts);
  });

  it("validates parallel function calls (only first needs signature)", () => {
    const parts: GeminiAiAdapter.Part[] = [
      {
        functionCall: { name: "get_current_temperature", args: { location: "Paris" } },
        thoughtSignature: "sig-A"
      },
      {
        functionCall: { name: "get_current_temperature", args: { location: "London" } }
        // No signature required for parallel call
      }
    ];
    validateFunctionCallSignatures(parts);
  });

  it("throws if first functionCall is missing signature", () => {
    const parts: GeminiAiAdapter.Part[] = [
      {
        functionCall: { name: "get_current_temperature", args: { location: "Paris" } }
        // Missing thoughtSignature
      },
      {
        functionCall: { name: "get_current_temperature", args: { location: "London" } }
      }
    ];
    expect(() => validateFunctionCallSignatures(parts)).toThrow();
  });

  it("accepts dummy signature for injected calls", () => {
    const parts: GeminiAiAdapter.Part[] = [
      {
        functionCall: { name: "custom_call", args: {} },
        thoughtSignature: "context_engineering_is_the_way_to_go"
      }
    ];
    validateFunctionCallSignatures(parts);
  });

  it("accepts optional thoughtSignature for text parts", () => {
    const parts: GeminiAiAdapter.Part[] = [
      {
        text: "I need to calculate the risk. Let me think step-by-step...",
        thought: true,
        thoughtSignature: "sig-C"
      },
      {
        text: "Final answer.",
        thought: false
      }
    ];
    // No error if omitted
    expect("thoughtSignature" in parts[1] ? (parts[1] as any).thoughtSignature : undefined).toBeUndefined();
  });
});
