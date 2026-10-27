import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// GitHub Pages project site: https://<user>.github.io/<repo>/
// The deploy workflow passes BASE_PATH (= actions/configure-pages `base_path`, e.g. "/<repo>").
// Without it, a relative base ('./') is used, so `npm run build` output also works from any sub-path.
function resolveBase() {
  const raw = (process.env.BASE_PATH || '').trim()
  if (!raw) return './'
  return raw.endsWith('/') ? raw : `${raw}/`
}

export default defineConfig({
  base: resolveBase(),
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Firebase SDK makes the main chunk ~0.9 MB (≈290 kB gzip); expected for this app.
    chunkSizeWarningLimit: 1200,
  },
})
