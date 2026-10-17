import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'

const require = createRequire(import.meta.url)
const cesiumMod = require('vite-plugin-cesium') as {
  default: (opts?: object) => import('vite').Plugin
}
const vitePluginCesium = cesiumMod.default

/** Project Pages need e.g. `/WarsInAllWorld/`; set via VITE_BASE in CI. */
const base = process.env.VITE_BASE || '/'

/**
 * vite-plugin-cesium joins Vite `base` into the copy destination. With
 * `base: /Repo/`, that becomes `dist/Repo/cesium/` (or worse on Linux), while
 * index.html correctly requests `/Repo/cesium/Cesium.js` → 404 and
 * "Cesium is not defined" on GitHub Pages.
 *
 * Also emit map/globe/insights/index.html copies so project Pages deep links
 * return 200 (custom 404.html is unreliable for username.github.io/repo/).
 */
function fixCesiumPagesCopy(): Plugin {
  return {
    name: 'fix-cesium-pages-copy',
    apply: 'build',
    closeBundle: {
      sequential: true,
      order: 'post',
      handler() {
        const outDir = path.resolve('dist')
        const right = path.join(outDir, 'cesium')
        const baseSeg = base.replace(/^\/+|\/+$/g, '')
        const candidates = [
          baseSeg ? path.join(outDir, baseSeg, 'cesium') : '',
          // Linux absolute join bug: files land at /Repo/cesium
          baseSeg ? path.posix.join('/', baseSeg, 'cesium') : '',
        ].filter(Boolean)

        for (const wrong of candidates) {
          if (!wrong || wrong === right || !fs.existsSync(wrong)) continue
          if (fs.existsSync(right)) fs.rmSync(right, { recursive: true, force: true })
          fs.mkdirSync(path.dirname(right), { recursive: true })
          fs.renameSync(wrong, right)
          const parent = path.dirname(wrong)
          if (
            parent.startsWith(outDir) &&
            parent !== outDir &&
            fs.existsSync(parent) &&
            fs.readdirSync(parent).length === 0
          ) {
            fs.rmdirSync(parent)
          }
          break
        }

        if (!fs.existsSync(path.join(right, 'Cesium.js'))) {
          console.warn(
            '[fix-cesium-pages-copy] Cesium.js missing under dist/cesium — Globe may fail on Pages',
          )
        }

        const indexHtml = path.join(outDir, 'index.html')
        if (fs.existsSync(indexHtml)) {
          fs.copyFileSync(indexHtml, path.join(outDir, '404.html'))
          // Pretty URLs on GitHub Pages: globe.html → /globe (no trailing slash)
          for (const route of ['map', 'globe', 'insights']) {
            fs.copyFileSync(indexHtml, path.join(outDir, `${route}.html`))
          }
        }
      },
    },
  }
}

export default defineConfig({
  base,
  plugins: [react(), vitePluginCesium(), fixCesiumPagesCopy()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
