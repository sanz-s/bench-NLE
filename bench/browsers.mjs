/**
 * The browsers bench/run.mjs can drive, one engine each by default (shared with bench/bench-os.mjs's checks).
 *
 *   --browsers all                 chrome, firefox, webkit (Blink, Gecko, WebKit): the default
 *                                  WebKit stands for Safari, which exists only on macOS: it is always skipped on
 *                                  Linux and Windows (Playwright's WebKit ports there aren't Safari's engine build)
 *   --browsers chrome,edge         any comma list of: chrome, edge, chromium, firefox, webkit
 *   --chromium                     old flag: same as --browsers chromium
 *
 * Firefox and WebKit are Playwright's own builds (Playwright can't drive stock Firefox or Safari). Install them with
 * `npx playwright install --with-deps` (on Linux --with-deps also installs the system libraries, via sudo apt).
 */
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const BROWSERS = {
  chrome: { engine: 'Blink', type: 'chromium', channel: 'chrome', name: 'Google Chrome' },
  edge: { engine: 'Blink', type: 'chromium', channel: 'msedge', name: 'Microsoft Edge' },
  chromium: { engine: 'Blink', type: 'chromium', name: 'Chromium (Playwright build)' },
  firefox: { engine: 'Gecko', type: 'firefox', name: 'Firefox (Playwright build)' },
  webkit: { engine: 'WebKit', type: 'webkit', name: 'WebKit (Playwright build, not Safari)' },
}
export const ALL = ['chrome', 'firefox', 'webkit']
export const INSTALL_CMD = 'npx playwright install --with-deps'

/** The browser keys asked for on a command line (argv without the node/script parts). Throws on an unknown name. */
export function requestedBrowsers(argv) {
  const i = argv.indexOf('--browsers')
  const raw = i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : argv.includes('--chromium') ? 'chromium' : 'all'
  const keys = [...new Set(raw.split(',').flatMap((k) => (k.trim() === 'all' ? ALL : [k.trim().toLowerCase()])).filter(Boolean))]
  const bad = keys.filter((k) => !BROWSERS[k])
  if (bad.length) throw new Error(`unknown browser ${bad.join(', ')} (use ${Object.keys(BROWSERS).join(', ')} or all)`)
  return keys
}

/** Where Chrome / Edge are normally installed on this OS. */
export function channelPaths(channel, platform = process.platform) {
  if (channel === 'chrome') {
    if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
    if (platform === 'win32') return [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map((d) => path.join(d, 'Google\\Chrome\\Application\\chrome.exe'))
    return ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
  }
  if (channel === 'msedge') {
    if (platform === 'darwin') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    if (platform === 'win32') return [process.env['PROGRAMFILES(X86)'], process.env.PROGRAMFILES].filter(Boolean).map((d) => path.join(d, 'Microsoft\\Edge\\Application\\msedge.exe'))
    return ['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
  }
  return []
}

/**
 * Is this browser installed (and does it belong on this OS)? → { ok, path, fix, platformSkip? }. `playwright` is the imported module (null if it isn't installed).
 * Chrome counts as available when only Playwright's Chromium is there: run.mjs falls back to it and says so.
 */
export function browserAvailability(key, playwright, platform = process.platform) {
  const b = BROWSERS[key]
  if (key === 'webkit' && platform !== 'darwin') return { ok: false, path: null, platformSkip: true, fix: 'Safari / WebKit runs only on macOS, so it is skipped on Linux and Windows' }
  const pwPath = (type) => {
    try {
      const p = playwright?.[type]?.executablePath()
      return p && existsSync(p) ? p : null
    } catch {
      return null
    }
  }
  if (b.channel) {
    const found = channelPaths(b.channel).find((p) => existsSync(p))
    if (found) return { ok: true, path: found }
    if (key === 'chrome') {
      const bundled = pwPath('chromium')
      if (bundled) return { ok: true, path: bundled, fallback: 'Google Chrome not found: Playwright Chromium is used instead (hardware encoders may differ)' }
    }
    return { ok: false, path: null, fix: key === 'chrome' ? `install Google Chrome (or run \`${INSTALL_CMD}\` for Playwright Chromium)` : 'install Microsoft Edge' }
  }
  const p = pwPath(b.type)
  return p ? { ok: true, path: p } : { ok: false, path: null, fix: `run \`${INSTALL_CMD}\`` }
}
