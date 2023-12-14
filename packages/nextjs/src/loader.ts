import fs from "fs";
import glob from "glob";
import { type NextConfig } from "next";
import path from "path";

/**
 * Uses `glob` to find an `inngest/index.ts` file in the project and returns the
 * directory it's in.
 */
const findInngestDir = (dir: string): string | null => {
  const inngestDir = glob.sync(`${dir}/**/inngest/index.ts`)[0];
  if (!inngestDir) {
    return null;
  }
  return path.dirname(inngestDir);
};

const generateRouteFile = (inngestDir: string): void => {
  // TODO ts only, app only, src only
  const routePath = path.resolve(
    __dirname,
    "src",
    "app",
    "api",
    "inngest",
    "route.ts"
  );
  const routeDir = path.dirname(routePath);
  let imports: { fnId: string; eventName: string; importStatement: string }[] =
    [];

  // Generate our route file.
  // TODO ts only, app only, src only, event trigger only
  glob.sync(`${inngestDir}/**/!(*index).{ts,js}`).forEach((file, i) => {
    const relativePath = path.relative(routeDir, file);

    const eventName = path
      .dirname(path.relative(inngestDir, file))
      .split(path.sep)
      .join("/");

    const fnId = path.basename(file, ".ts");

    imports.push({
      fnId,
      eventName,
      importStatement: `import fn${i}Handler from "${relativePath.replace(
        ".ts",
        ""
      )}";`,
    });
  });

  if (!imports.length) {
    return console.log("[Inngest] No functions found");
  }

  const logMsg = [
    "[Inngest] Generating route file",
    imports.map(({ fnId, eventName }) => `${eventName} -> ${fnId}`),
  ];

  // TODO ts only, import only, alias only, assuming location
  const staticImports = `import { inngest } from "@/inngest";
  import { serve } from "inngest/next";`;

  const fns = imports.map(({ importStatement, fnId, eventName }, i) => {
    return `${importStatement}
    const fn${i} = inngest.createFunction({id:"${fnId}"},{event:"${eventName}"},fn${i}Handler);`;
  });

  // TODO ts only, export only
  const staticExports = `
  export const { GET, POST, PUT } = serve({
    client: inngest,
    functions: [${imports.map((_, i) => `fn${i}`).join(", ")}],
  });
  `;

  // TODO bad - should use template file and replace.
  const routeContent = `//GENERATED FILE
  ${staticImports}
  ${fns}
  ${staticExports}`;

  const dir = path.dirname(routePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(routePath, routeContent);

  return console.log(...logMsg);
};

/**
 * Creates a Next.js config function that will generate a route file for Inngest
 * functions.
 *
 * @example Create a new `next.config.js`
 * ```js
 * const withInngest = require("@inngest/nextjs")();
 * const nextConfig = {};
 * module.exports = withInngest(nextConfig);
 * ```
 */
const createInngestConfig =
  () =>
  async (nextConfig: NextConfig = {}): Promise<NextConfig> => {
    const inngestDir = findInngestDir(process.cwd());
    if (!inngestDir) {
      // TODO Log that we didn't find an Inngest `index.ts`. We can also log a
      // basic one. Maybe we can also generate a basic one if we didn't find one?
      // It'd be `if (src exists) { generate src/inngest/index.ts } else { generate inngest/index.ts }
      return nextConfig;
    }

    // TODO Route file always generated.
    // Multiple webpack configs are generated from this. We need to make sure it
    // only happens once. Is this file only imported once? Singleton? Temp file
    // in `.next/` for the build?
    const logMsg = generateRouteFile(inngestDir);

    return {
      ...nextConfig,
      webpack: (config, options) => {
        // Call the original webpack function from the Next.js config if it exists
        if (typeof nextConfig.webpack === "function") {
          config = nextConfig.webpack(config, options);
        }

        if (options.isServer && options.nextRuntime === "nodejs") {
          // Bad workaround to log only once - see file generation TODO above
          console.log(logMsg);
        }

        // Important: return the modified config
        return config;
      },
    };
  };

export default createInngestConfig;
