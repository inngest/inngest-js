import type { NextConfig } from "next";
import path from "path";

const inngestSrc = path.resolve(__dirname, "../../packages/inngest/src");

const nextConfig: NextConfig = {
  // Skip type checking — inngest source types target a different Next.js
  // version than this example, causing false positives.
  typescript: { ignoreBuildErrors: true },

  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      inngest: inngestSrc,
    };

    // The inngest source uses .js extensions in imports (TS ESM convention).
    // This tells webpack to try .ts/.tsx before .js when resolving.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };

    return config;
  },
};

export default nextConfig;
