#!/usr/bin/env node

/**
 * Fetches the latest model string literals from the official OpenAI and
 * Anthropic SDK packages (via unpkg) and merges them into the `@inngest/ai`
 * type unions.
 *
 * - Additive only — never removes models.
 * - Writes a changeset when any file changes.
 * - Always exits 0 (skips providers whose fetch fails).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const repoRoot = resolve(pkgRoot, "../..");

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

/**
 * Prefixes that indicate non-chat OpenAI models we want to exclude.
 */
const OPENAI_EXCLUDE_PREFIXES = [
  "text-embedding-",
  "tts-",
  "whisper-",
  "dall-e-",
  "davinci-",
  "babbage-",
  "text-moderation-",
  "omni-moderation-",
];

const providers = [
  {
    name: "OpenAI",
    url: "https://unpkg.com/openai@latest/resources/shared.d.ts",
    /** Regex to find the `ChatModel` union in the fetched `.d.ts` */
    sdkTypeRegex: /type\s+ChatModel\s*=\s*([\s\S]*?);/,
    filterModel: (model) =>
      !OPENAI_EXCLUDE_PREFIXES.some((prefix) => model.startsWith(prefix)),
    targets: [
      {
        file: resolve(pkgRoot, "src/models/openai.ts"),
        /** Regex to match the full `export type Model = …;` block */
        typeRegex: /(export\s+type\s+Model\s*=)([\s\S]*?)(;)/,
      },
      {
        file: resolve(pkgRoot, "src/models/openai-responses.ts"),
        typeRegex: /(export\s+type\s+Model\s*=)([\s\S]*?)(;)/,
      },
    ],
  },
  {
    name: "Anthropic",
    url: "https://unpkg.com/@anthropic-ai/sdk@latest/resources/messages/messages.d.ts",
    sdkTypeRegex: /type\s+Model\s*=\s*([\s\S]*?);/,
    filterModel: () => true,
    targets: [
      {
        file: resolve(pkgRoot, "src/adapters/anthropic.ts"),
        typeRegex: /(export\s+type\s+Model\s*=)([\s\S]*?)(;)/,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract string literals from a TS union type body.
 * Matches both single- and double-quoted strings.
 */
function extractModels(unionBody) {
  const models = new Set();
  for (const match of unionBody.matchAll(/["']([^"']+)["']/g)) {
    models.add(match[1]);
  }
  return models;
}

/**
 * Build the formatted type union string.
 * `(string & {})` always comes first, then sorted model literals.
 */
function formatUnion(models, indent) {
  const sorted = [...models].sort();
  const lines = [`${indent}| (string & {})`];
  for (const m of sorted) {
    lines.push(`${indent}| "${m}"`);
  }
  return "\n" + lines.join("\n");
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let anyFileChanged = false;

  for (const provider of providers) {
    console.log(`[${provider.name}] Fetching ${provider.url}`);

    let sdkText;
    try {
      sdkText = await fetchText(provider.url);
    } catch (err) {
      console.warn(`[${provider.name}] Fetch failed, skipping: ${err.message}`);
      continue;
    }

    // Extract models from the SDK type definition
    const sdkMatch = sdkText.match(provider.sdkTypeRegex);
    if (!sdkMatch) {
      console.warn(
        `[${provider.name}] Could not find type union in SDK, skipping`,
      );
      continue;
    }

    const sdkModels = extractModels(sdkMatch[1]);
    console.log(`[${provider.name}] Found ${sdkModels.size} models in SDK`);

    // Apply provider-specific filter
    for (const model of sdkModels) {
      if (!provider.filterModel(model)) {
        sdkModels.delete(model);
      }
    }

    console.log(`[${provider.name}] ${sdkModels.size} models after filtering`);

    if (sdkModels.size === 0) {
      console.warn(
        `[${provider.name}] No models found after filtering, skipping`,
      );
      continue;
    }

    // Update each target file
    for (const target of provider.targets) {
      const filePath = target.file;
      console.log(`[${provider.name}] Processing ${filePath}`);

      const content = readFileSync(filePath, "utf-8");
      const typeMatch = content.match(target.typeRegex);
      if (!typeMatch) {
        console.warn(
          `[${provider.name}] Could not find Model type in ${filePath}, skipping`,
        );
        continue;
      }

      // Current models in the file
      const currentModels = extractModels(typeMatch[2]);

      // Merge: union of current + SDK (additive only)
      const merged = new Set([...currentModels, ...sdkModels]);

      // Check if anything changed
      if (merged.size === currentModels.size) {
        console.log(`[${provider.name}] No new models for ${filePath}`);
        continue;
      }

      const newModels = [...merged].filter((m) => !currentModels.has(m));
      console.log(
        `[${provider.name}] Adding ${newModels.length} new model(s): ${newModels
          .sort()
          .join(", ")}`,
      );

      // Detect indentation from the existing `|` lines in the matched block.
      const lineIndentMatch = typeMatch[0].match(/^(\s*)\| ["(]/m);
      const indent = lineIndentMatch ? lineIndentMatch[1] : "    ";

      const newUnion = formatUnion(merged, indent);
      const newContent = content.replace(target.typeRegex, `$1${newUnion}$3`);

      writeFileSync(filePath, newContent, "utf-8");
      anyFileChanged = true;
      console.log(`[${provider.name}] Updated ${filePath}`);
    }
  }

  // Write changeset if anything changed
  if (anyFileChanged) {
    const changesetDir = resolve(repoRoot, ".changeset");
    if (!existsSync(changesetDir)) {
      mkdirSync(changesetDir, { recursive: true });
    }

    const changesetPath = resolve(changesetDir, "update-ai-models.md");
    const changesetContent = `---
"@inngest/ai": patch
---

Update AI model types from latest provider SDKs
`;
    writeFileSync(changesetPath, changesetContent, "utf-8");
    console.log(`\nChangeset written to ${changesetPath}`);
  } else {
    console.log("\nNo changes detected, no changeset needed.");
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  // Always exit 0 — this is a best-effort automation
  process.exit(0);
});
