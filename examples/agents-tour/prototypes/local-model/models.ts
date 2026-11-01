/**
 * @module
 * The candidate models. All are 4-bit GGUFs (Q4_K_M, except where the repo
 * ships another 4-bit file). Throwaway prototype.
 */

/**
 * One candidate: where it comes from and how it is told not to think.
 */
export interface Candidate {
  name: string;
  uri: string;
}

export const candidates: Candidate[] = [
  { name: "qwen3-0.6b", uri: "hf:unsloth/Qwen3-0.6B-GGUF:Q4_K_M" },
  { name: "qwen3.5-0.8b", uri: "hf:unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M" },
  { name: "qwen3-1.7b", uri: "hf:unsloth/Qwen3-1.7B-GGUF:Q4_K_M" },
  {
    name: "qwen3-4b-instruct-2507",
    uri: "hf:unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M",
  },
  { name: "qwen3.5-2b", uri: "hf:unsloth/Qwen3.5-2B-GGUF:Q4_K_M" },
  { name: "qwen3.5-4b", uri: "hf:unsloth/Qwen3.5-4B-GGUF:Q4_K_M" },
  { name: "gemma-4-e2b", uri: "hf:unsloth/gemma-4-E2B-it-GGUF:Q4_K_M" },
];

export const cacheDir = `${process.env.HOME}/.cache/agents-tour-models`;
