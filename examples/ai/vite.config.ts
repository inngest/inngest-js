import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tsConfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  server: {
    port: 3000,
  },
  // The symlinked local `inngest` package would otherwise be bundled through
  // Vite's SSR pipeline, which trips over its CJS/ESM interop; loading it
  // directly from node also means every local rebuild is picked up.
  ssr: {
    external: ['inngest'],
  },
  plugins: [
    tsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tanstackStart(),
    viteReact(),
  ],
})
