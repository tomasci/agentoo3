// The browser skill's three-way contract: mcp.json, the install script, and
// what @playwright/mcp actually is.
//
// These are three files written by different hands with nothing connecting
// them, and every disagreement between them fails *at navigation time* inside
// an agent session — not at install, and not at MCP connect (the server
// connects and offers all 24 tools regardless, so the worker's
// "did not connect" warning never fires).
//
// The facts below were established empirically against @playwright/mcp@0.0.80
// on 2026-09-14: `npm view @playwright/mcp@0.0.80 bin` => { playwright-mcp:
// cli.js }, and a real stdio MCP session (initialize + tools/list +
// tools/call) against that package.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

const REPO = join(import.meta.dir, '..', '..')
const MCP_JSON = join(REPO, 'library.example', 'skills', 'browser', 'mcp.json')
const SKILL_MD = join(REPO, 'library.example', 'skills', 'browser', 'SKILL.md')
const INSTALL = join(REPO, 'scripts', '57-install-playwright.sh')
const CONFIG = join(REPO, 'scripts', 'lib', 'config.sh')

async function playwrightArgs(): Promise<string[]> {
  const parsed = JSON.parse(await readFile(MCP_JSON, 'utf8')) as {
    mcpServers: Record<string, { command: string; args?: string[] }>
  }
  return parsed.mcpServers.playwright?.args ?? []
}

test('mcp.json invokes the bin name @playwright/mcp actually installs', async () => {
  const parsed = JSON.parse(await readFile(MCP_JSON, 'utf8')) as {
    mcpServers: Record<string, { command: string }>
  }
  // `npm view @playwright/mcp@0.0.80 bin` => { 'playwright-mcp': 'cli.js' }.
  expect(parsed.mcpServers.playwright?.command).toBe('playwright-mcp')
  // And the install script verifies exactly that name resolves on PATH.
  expect(await readFile(INSTALL, 'utf8')).toContain('have playwright-mcp')
})

test('every flag mcp.json passes exists in @playwright/mcp@0.0.80', async () => {
  // Verified against `playwright-mcp --help` for the pinned version, and the
  // full shipped argv was confirmed to bring the server up (a real stdio
  // `initialize` answered with serverInfo Playwright/1.63.0-alpha-2026-08-31).
  // Kept as a list rather than a live --help call because the package is not
  // a backend dependency and is not installed in CI.
  //
  // What a bad flag costs, precisely: commander exits with
  // `error: unknown option '--x'` before the server ever speaks MCP — so the
  // session simply has no `mcp__playwright__*` tools, with nothing in the
  // transcript naming the typo. Loud at the process, silent to the agent.
  const known = new Set([
    '--headless',
    '--isolated',
    '--browser',
    '--viewport-size',
    '--no-sandbox',
    '--user-data-dir',
    '--output-dir',
    '--output-max-size',
    '--caps',
    '--device',
    '--timeout-action',
    '--timeout-navigation',
  ])
  for (const arg of await playwrightArgs()) {
    if (arg.startsWith('--')) expect(known.has(arg)).toBe(true)
  }
  // And the pinned version this was checked against has not moved underneath
  // the list above without someone noticing.
  expect(await readFile(CONFIG, 'utf8')).toContain('PLAYWRIGHT_MCP_VERSION:-0.0.80')
})

/** Every Playwright browser/channel name, so a token extracted below is only
 * treated as a browser when it actually is one — and so a drift to *any*
 * other real browser is still caught, not just a drift back to `chrome`. */
const BROWSER_WORDS = new Set([
  'chromium',
  'chromium-headless-shell',
  'chrome',
  'chrome-beta',
  'chrome-dev',
  'chrome-canary',
  'firefox',
  'webkit',
  'msedge',
  'msedge-beta',
  'msedge-dev',
])

/** Branded channels: Playwright resolves these to a fixed system path (Google
 * Chrome at /opt/google/chrome/chrome) rather than to a build it downloads,
 * so `playwright install <channel>` and `playwright install chromium` are not
 * interchangeable. This set is the *reason* the original defect existed. */
const CHANNEL_ONLY = new Set([
  'chrome',
  'chrome-beta',
  'chrome-dev',
  'chrome-canary',
  'msedge',
  'msedge-beta',
  'msedge-dev',
])

/** Every browser the install script names, at any of its call sites — the two
 * real invocations (`install-deps <b>`, `install <b>`), the dry-run preview
 * line and both `die` messages. All of them have to agree, so a fix applied
 * to one and not the others is caught here too. */
async function installedBrowsers(): Promise<string[]> {
  const text = await readFile(INSTALL, 'utf8')
  return [...text.matchAll(/\binstall(?:-deps)?\s+([a-z][a-z0-9-]*)/g)]
    .map((m) => m[1] as string)
    .filter((word) => BROWSER_WORDS.has(word))
}

test('mcp.json --browser and the browser the installer installs are the same string', async () => {
  // THE contract, in two files nothing else connects. They disagreed once
  // (`--browser chrome` against `playwright install chromium`) and the only
  // symptom was every navigation failing inside an agent session with
  // "Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome"
  // — the MCP server still connects and still lists all 24 tools, so nothing
  // earlier warns. This test is what makes that drift impossible to land
  // quietly again.
  const args = await playwrightArgs()
  const browserArg = args[args.indexOf('--browser') + 1]
  const installed = await installedBrowsers()

  // Guard against the extraction silently finding nothing and the equality
  // below passing vacuously.
  expect(installed.length).toBeGreaterThanOrEqual(2)
  expect(browserArg).toBeDefined()

  // Every site names one and the same browser.
  expect([...new Set(installed)]).toEqual([browserArg as string])
})

test('the browser both files name is a downloadable build, not a branded channel', async () => {
  // Agreeing on `chrome` in both files would satisfy the test above and still
  // be wrong on this box: `playwright install chrome` installs Google Chrome
  // system-wide, which 57-install-playwright.sh's "chromium only, no extra
  // apt surface" reasoning explicitly does not want. Verified against
  // @playwright/mcp@0.0.80: `--browser chromium` launches the downloaded
  // build at .../chromium-<rev>/chrome-linux64/chrome.
  const args = await playwrightArgs()
  const browserArg = args[args.indexOf('--browser') + 1] as string
  expect(BROWSER_WORDS.has(browserArg)).toBe(true)
  expect(CHANNEL_ONLY.has(browserArg)).toBe(false)
  expect(browserArg).toBe('chromium')
})

test('an explicit --browser is passed at all — the server default is a channel', async () => {
  // @playwright/mcp@0.0.80 defaults to the `chrome` *channel* when --browser
  // is omitted (observed: omitting it reproduces the same
  // "/opt/google/chrome/chrome" failure). So "just drop the flag" is not a
  // fix, and the flag has to stay present.
  const args = await playwrightArgs()
  expect(args).toContain('--browser')
})

test('SKILL.md documents the real navigation-time symptom and the two-file contract', async () => {
  const text = await readFile(SKILL_MD, 'utf8')
  // The actual error an agent sees, so the skill's troubleshooting section is
  // recognisable rather than describing a message the server never emits.
  expect(text).toContain('isError: true')
  expect(text).toContain('### Error')
  expect(text).toContain('Chromium distribution')
  // And the coupling is written down where whoever edits mcp.json will see it.
  expect(text).toContain('scripts/57-install-playwright.sh')
})

test('every mcp__playwright__ tool SKILL.md names exists on the real server', async () => {
  // The 24 tools @playwright/mcp@0.0.80 answered `tools/list` with.
  const real = new Set([
    'browser_close', 'browser_resize', 'browser_console_messages',
    'browser_handle_dialog', 'browser_evaluate', 'browser_file_upload',
    'browser_drop', 'browser_find', 'browser_fill_form', 'browser_press_key',
    'browser_type', 'browser_navigate', 'browser_navigate_back',
    'browser_network_requests', 'browser_network_request',
    'browser_run_code_unsafe', 'browser_take_screenshot', 'browser_snapshot',
    'browser_click', 'browser_drag', 'browser_hover', 'browser_select_option',
    'browser_tabs', 'browser_wait_for',
  ])
  const named = [...(await readFile(SKILL_MD, 'utf8')).matchAll(/`(browser_[a-z_]+)`/g)].map(
    (m) => m[1] as string,
  )
  expect(named.length).toBeGreaterThan(0)
  const missing = [...new Set(named)].filter((n) => !real.has(n))
  expect(missing).toEqual([])
})

// --- how the install script reaches the Playwright CLI --------------------
//
// Not runnable in this suite: proving it end to end needs a real
// `npm install -g @playwright/mcp`, i.e. the network and a global prefix, and
// a test that does either is a test that fails on someone else's machine. It
// was verified by hand instead (see the report): against a real global
// install, the old form reproduces ERR_PACKAGE_PATH_NOT_EXPORTED every time
// and the new form resolves a runnable cli.js at the pinned version.
//
// What is cheap and deterministic is guarding the *form*, because the defect
// was entirely a matter of which subpath is asked for — and it took the whole
// installer down with it (install.sh exits on a failed step, so step 57
// failing blocks postgres, redis, backend and frontend on a fresh box).

test('the installer resolves playwright/package.json, never the unexported cli.js', async () => {
  const text = await readFile(INSTALL, 'utf8')
  // Comments stripped: the script *documents* the broken form in a comment
  // explaining why it is not used, so asserting over the raw text would fail
  // on the explanation rather than on the code. Only executable lines count.
  const code = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

  // `require.resolve('playwright/cli.js', ...)` throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED: the `playwright` version @playwright/mcp
  // pins publishes an `exports` map that does not list './cli.js'. This is
  // deterministic, not a transient or layout-dependent failure.
  expect(code).not.toContain("require.resolve('playwright/cli.js'")

  // './package.json' is exported by every package — Node special-cases it —
  // so it is the one subpath that can always be resolved, and the CLI sits
  // next to it in every published playwright release.
  expect(code).toContain("require.resolve('playwright/package.json'")

  // Still resolved from @playwright/mcp's *own* dependency tree, which is the
  // whole reason this is not just `command -v playwright`: the browser
  // revision that gets downloaded is tied to the version the MCP server pins,
  // not to whatever `playwright` is otherwise on the box.
  expect(code).toContain("paths: ['$mcp_pkg_dir']")

  // Derived from the resolved package.json's directory...
  expect(code).toMatch(/playwright_cli="\$\(dirname -- "\$pkg_json"\)\/cli\.js"/)
  // ...and checked to exist, so a future layout change fails here, naming the
  // path, rather than three lines later inside `node <empty>`.
  expect(code).toMatch(/\[\[ -f "\$playwright_cli" \]\] \|\| die/)
})

// --- where screenshots land ----------------------------------------------
//
// `browser_take_screenshot` with an explicit `filename` goes through a
// different code path from the one `--output-dir` feeds
// (resolveClientFilename -> workspaceFile(filename, cwd)), so in 0.0.80 it
// writes to the MCP server process's cwd — the session's own git worktree —
// and returns no inline image. `--output-dir` fixes the *default*-named
// artifacts; SKILL.md telling agents not to pass `filename` is what covers
// the rest. Both halves are load-bearing and neither is self-evident from
// reading mcp.json, so both are pinned here.

test('mcp.json sends default-named output somewhere outside any project checkout', async () => {
  const args = await playwrightArgs()
  const outputDir = args[args.indexOf('--output-dir') + 1]
  expect(args).toContain('--output-dir')
  expect(outputDir).toBeDefined()
  // Absolute: a relative path would resolve against the server process's cwd,
  // which is the very worktree this flag exists to keep clean.
  expect(outputDir?.startsWith('/')).toBe(true)
  // And an eviction threshold, so the directory cannot grow without bound on
  // a long-lived box.
  const maxSize = args[args.indexOf('--output-max-size') + 1]
  expect(Number(maxSize)).toBeGreaterThan(0)
  expect(Number.isInteger(Number(maxSize))).toBe(true)
})

test('the output directory is gitignored at the repo root — this box self-hosts', async () => {
  // The repo root of a self-hosting install *is* /opt/agentoo, so an output
  // dir at /opt/agentoo/browser-output lands inside this very checkout. The
  // .gitignore entry is what keeps screenshots out of `git status`; change
  // --output-dir without it and they start showing up as untracked files in
  // every session's diff.
  const args = await playwrightArgs()
  const outputDir = args[args.indexOf('--output-dir') + 1] as string
  const leaf = outputDir.slice(outputDir.lastIndexOf('/') + 1)
  const ignored = (await readFile(join(REPO, '.gitignore'), 'utf8'))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))

  // Root-anchored, like its siblings /keys/ and /attachments/, so it cannot
  // accidentally ignore a same-named directory deeper in a project.
  expect(ignored).toContain(`/${leaf}/`)
})

test('SKILL.md tells the agent not to pass an explicit filename', async () => {
  // The only mitigation for the upstream bug --output-dir does not reach.
  // Drop this guidance and screenshots silently return no image *and* land in
  // the worktree again.
  const text = await readFile(SKILL_MD, 'utf8')
  expect(text).toContain('`filename`')
  expect(text).toMatch(/no `filename`|not? `filename`|without .*`filename`/)
  // And it says what goes wrong, not just "don't": the two symptoms an agent
  // would otherwise have to diagnose from nothing.
  expect(text).toContain('no image')
  expect(text.toLowerCase()).toContain('working directory')
})
