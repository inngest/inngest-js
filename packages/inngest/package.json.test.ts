import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("package.json", () => {
  it("should be valid", () => {
    const packageJsonSchema = z.object({
      exports: z.record(z.string(), z.string()),
      publishConfig: z.object({
        exports: z.record(
          z.string(),
          z.object({
            import: z.string(),
            require: z.string(),
            types: z.object({
              import: z.string(),
              require: z.string(),
            }),
          }),
        ),
      }),
    });

    const packageJson = packageJsonSchema.parse(
      JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")),
    );

    // Every `exports` key exists in `publishConfig.exports`
    for (const k in packageJson.exports) {
      expect(Object.keys(packageJson.publishConfig.exports)).toContain(k);
    }

    // Every `publishConfig.exports` value is correct
    for (const [k, v] of Object.entries(packageJson.publishConfig.exports)) {
      let name = k;

      // Special case for the root export
      if (name === ".") {
        name = "./index";
      }

      expect(v).toEqual({
        // ESM
        import: `${name}.js`,

        // CommonJS
        require: `${name}.cjs`,

        types: {
          // ESM types
          import: `${name}.d.ts`,

          // CommonJS types
          require: `${name}.d.cts`,
        },
      });
    }
  });
});
