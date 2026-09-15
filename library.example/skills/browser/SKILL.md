---
name: browser
description: Use when you need to load a page in a real browser and check what it actually does — navigate a URL, read the rendered content, click or type, take a screenshot, or check for console errors and failed network requests. Use to verify a running app from the outside, the way a user would hit it, not by reading its source.
---

# Browser

This skill gives you a real, headless Chrome through the Playwright MCP
server. Its tools show up with the prefix `mcp__playwright__*` — for example
`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_take_screenshot`, `browser_console_messages`,
`browser_network_requests`. If you are not sure a name is exact, list your
available `mcp__playwright__*` tools first rather than guessing one — a name
that is close but wrong just fails, and a hardcoded guess in a script you
write is the same mistake with worse visibility.

## Get a URL first, never guess one

Before you navigate anywhere, get the address from `agentoo:docker` — its
`status` and `addresses` commands read the address the daemon actually
published, including which host (Tailscale, LAN, loopback) can reach it from
where this session runs. A port you remember from a previous run, or a
`localhost:3000` typed from habit, is not the same claim; use the skill built
to answer this instead of assuming.

## Assert on the snapshot, not the screenshot

`browser_snapshot` returns the accessibility tree as text — cheap to produce,
cheap to read, and the thing you can actually assert against ("does the page
contain a heading that says X", "is there a button labelled Y"). Prefer it for
every check that is really a question about content or state.

`browser_take_screenshot` is for a human, not for you: you cannot compare
pixels to an expectation, so a screenshot only ever tells you "something
rendered," never "the right thing rendered." Use it to attach evidence to a
report, not as the check itself.

A page that loads is not a passing page. Load it, then check the specific
thing you were asked to check — an element, its text, a value on the page —
in the snapshot. "It came back with a 200" and "the page loaded" are not
assertions.

## Console and network are part of the check

Call `browser_console_messages` and `browser_network_requests` after any
navigation or interaction you care about. A page that renders correctly and
throws in the console, or that quietly fails a fetch the UI swallows, is not
working — it looks fine only because nobody looked at the layer where the
failure actually surfaced. Check both explicitly; do not treat their absence
from your check as evidence they were clean.

## When it does not work, say so — do not route around it

Two failure modes are common and both mean "report a blocked result," not
"find another way in":

- **A tool call comes back `isError: true` with a `### Error` message reading
  something like `Chromium distribution 'chrome' is not found at
  /opt/google/chrome/chrome`.** The host is missing the actual browser build
  Playwright expects to launch. This is an operator/install problem, not
  something you can fix by trying a different tool — and the MCP server
  itself connects fine and lists all its tools regardless, so nothing earlier
  in the session warns you; this error at navigation time is the first and
  only sign. Do not fall back to `curl`-ing the URL instead — that tells you
  the server answered HTTP, not that the page works, and reporting a pass on
  the strength of it would be reporting something you did not check. Report
  it as blocked/unverified, plainly.
- **No `mcp__playwright__*` tools exist at all.** The MCP server never
  connected — almost always because `playwright-mcp` is not installed on this
  host. Same rule: report it, do not improvise a substitute.

Either way, the honest report is "browser verification was blocked by X," not
a pass and not a guess dressed as one.

## `--browser` and the installed build are one contract, in two files

`mcp.json`'s `--browser` value and the build `scripts/57-install-playwright.sh`
actually installs (chromium) have to name the same browser. Playwright treats
`chrome` as the branded Google Chrome channel, resolved at a fixed path the
chromium installer never populates — so the two files silently disagreeing is
exactly the failure above, and it is invisible right up until a navigation is
attempted. Change one and not the other, and this breaks again the same way.
