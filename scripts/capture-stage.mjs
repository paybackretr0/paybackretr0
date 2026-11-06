/**
 * Captures the real 3D hero — the WebGL room from the portfolio — into a still
 * image for the README.
 *
 * The banner above the README is a baked SVG, which is the only way to get motion
 * into a GitHub profile page. This script exists for the second half of the
 * story: a poster shot of the *actual* live scene, so the "Live 3D stage" link
 * shows the thing it links to.
 *
 * It drives the portfolio's own dev server and renders with headless Chrome.
 * Chrome is started with the SwiftShader backend when no GPU is available, so the
 * script works on a headless machine as well as on a laptop.
 *
 *   node scripts/capture-stage.mjs
 *   PORTO_DIR=D:/Project/porto-lied CHROME_PATH=... node scripts/capture-stage.mjs
 *
 * Output: assets/stage-3d.png (1440×620 by default, see CLIP below).
 *
 * `puppeteer-core` is borrowed from the portfolio checkout — this repo stays
 * dependency-free on purpose, so it resolves the module out of `node_modules`
 * there instead of installing anything.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const porto = process.env.PORTO_DIR ?? join(root, '..', 'porto-lied')
const outFile = join(root, 'assets', 'stage-3d.png')

const PORT = Number(process.env.STAGE_PORT ?? 5199)
const ORIGIN = `http://localhost:${PORT}`

/** The window of the hero that gets captured: wide, and low enough to hold the pool. */
const CLIP = { x: 0, y: 250, width: 1440, height: 620 }
const VIEWPORT = { width: 1440, height: 900 }

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

function resolveChrome() {
  const found = CHROME_CANDIDATES.find((path) => existsSync(path))
  if (!found) throw new Error('Chrome not found — set CHROME_PATH to the binary.')
  return found
}

function loadPuppeteer() {
  const manifest = join(porto, 'package.json')
  if (!existsSync(manifest)) {
    throw new Error(`Portfolio checkout not found at ${porto} — set PORTO_DIR.`)
  }
  const require = createRequire(manifest)
  return require('puppeteer-core')
}

/** Polls the preview server until it answers (or times out). */
async function waitForServer(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/en/`, { method: 'HEAD' })
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Dev server did not start on ${ORIGIN}`)
}

/**
 * The hero only boots WebGL once its canvas is on screen, and the CSS poster
 * fades out when it does — so that class is the signal that the scene is live,
 * not just that the page loaded.
 */
const SCENE_LIVE = () =>
  Boolean(document.querySelector('#home canvas')) &&
  !document.querySelector('.hero-fallback')?.className.includes('opacity-100')

async function main() {
  const puppeteer = loadPuppeteer()
  mkdirSync(dirname(outFile), { recursive: true })

  const vite = join(porto, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(vite)) throw new Error(`Vite not found in ${porto} — run npm install there first.`)

  console.log(`Starting the portfolio dev server on ${ORIGIN} …`)
  const server = spawn(process.execPath, [vite, '--port', String(PORT), '--strictPort'], {
    cwd: porto,
    stdio: 'ignore',
  })

  let browser
  try {
    await waitForServer()
    browser = await puppeteer.launch({
      executablePath: resolveChrome(),
      headless: true,
      args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--hide-scrollbars'],
    })

    const page = await browser.newPage()
    await page.setViewport({ ...VIEWPORT, deviceScaleFactor: 1 })

    // The theme is read from localStorage by the inline <head> script.
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('theme', 'dark')
      } catch {
        /* ignore */
      }
    })

    await page.goto(`${ORIGIN}/en/`, { waitUntil: 'networkidle2', timeout: 90_000 })
    await page.waitForFunction(SCENE_LIVE, { timeout: 60_000, polling: 250 })

    // Leave only the stage visible: the poster must not contain the copy column,
    // the navbar or the portrait, which the README draws in its own type.
    await page.addStyleTag({
      content: `
        #app * { visibility: hidden !important; }
        #home, #home > *, #home canvas, #home .stage-poster { visibility: visible !important; }
        .hero-copy, .hero-print, .hero-tail, .hero-scroll { display: none !important; }
      `,
    })

    // SwiftShader needs a moment to paint a full frame after the scene is ready.
    await new Promise((resolve) => setTimeout(resolve, 2500))

    await page.screenshot({ path: outFile, clip: CLIP })
    console.log(`  assets/stage-3d.png → ${Math.round(statSync(outFile).size / 1024)} kB`)
  } finally {
    await browser?.close()
    server.kill()
  }
}

main().catch((error) => {
  console.error(`Capture failed: ${error.message}`)
  process.exit(1)
})
