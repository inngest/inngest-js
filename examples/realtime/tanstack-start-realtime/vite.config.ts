import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  server: {
    port: 3000,
  },
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  plugins: [
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tailwindcss(),
    tanstackStart({ customViteReactPlugin: true }),
    viteReact(),
  ],
});
