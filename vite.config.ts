import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { resolve } from 'node:path'

const r = (p: string) => resolve(__dirname, p)

// https://tauri.app/v1/api/config — Tauri expects dev on a fixed port without strict HMR overlay.
const host = process.env.TAURI_DEV_HOST

export default defineConfig(async () => ({
  plugins: [
    vue(),
    AutoImport({
      resolvers: [ElementPlusResolver()],
      imports: ['vue', 'vue-router', 'pinia'],
      dts: 'src/auto-imports.d.ts',
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: 'src/components.d.ts',
      dirs: ['src/components'],
    }),
    viteStaticCopy({
      targets: [
        { src: 'src/muya/themes/*', dest: 'themes' },
        { src: 'static/themes/*', dest: 'themes' },
      ],
    }),
  ],

  resolve: {
    alias: {
      '@': r('src'),
      common: r('src/common'),
      muya: r('src/muya'),
      // Mermaid pulls in cytoscape; map to the UMD entry (original webpack workaround).
      'cytoscape/dist/cytoscape.umd.js': r('node_modules/cytoscape/dist/cytoscape.umd.js'),
      // Sequence-diagram bundle references its vendored Snap.svg as `snapsvg`.
      snapsvg: r('src/muya/lib/assets/libs/snapsvg-shim.js'),
      // fuzzaldrin and a few Muya call-sites reach for `path` — give them a
      // lightweight browser shim instead of letting Vite stub it to a thrower.
      path: r('src/common/node-shims/path.js'),
    },
  },

  optimizeDeps: {
    // ESM-only or otherwise quirky packages that Vite must pre-bundle so they
    // work the same as in the original webpack bundle.
    include: ['snabbdom', 'mermaid', 'vue', 'pinia', 'element-plus'],
  },

  // Tauri dev server settings — must match `build.devUrl` in tauri.conf.json
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      // Don't reload on Rust source changes; Tauri handles those separately.
      ignored: ['**/src-tauri/**', '**/output/**', '**/exports/**'],
    },
  },

  // Tauri 2 supports modern web platform features.
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    chunkSizeWarningLimit: 2000, // Muya bundles are large by design
  },
}))
