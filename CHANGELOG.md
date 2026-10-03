# Changelog

The What's new screen inside agentoo shows this same list after each update — reopen it any time via the version number in the status bar. Newest release first. Also available in [Russian](CHANGELOG.ru.md).

## 1.3.165 — 2026-10-03

### New
- Pick an accent colour in Settings — main buttons, links, switches and checkboxes take it on, separate from the background colour, so the two can match or contrast.
- Status colours, like a failed session's red, keep their own meaning whatever accent colour you choose.

### Improved
- With a background colour or gradient on, hovers, selected items and open menus now carry a tint of that colour instead of plain grey.
- The project sidebar's bottom menu (Project settings) now sits on frosted glass too, like the menus above it.

## 1.3.161 — 2026-10-03

### Improved
- With a custom shell background on, the tabs and sidebar menus now sit on their own small frosted-glass panels.

## 1.3.160 — 2026-10-03

### Fixed
- SSH key cards no longer push their contents down when a card next to them is taller.

## 1.3.159 — 2026-10-02

### New
- A What's new screen appears after each update — reopen it via the version number in the status bar.

### Improved
- The full changelog is now also on GitHub, in CHANGELOG.md.

## 1.2.158 — 2026-10-02

### New
- Pick a background colour or gradient and an icon pattern for the app shell in Settings — the content area turns to frosted glass while one is active.

## 1.2.156 — 2026-10-02

### New
- Each project now has an Env files page (next to Docker in its sidebar) — store .env files there and they're copied into every new session's worktree automatically.

## 1.2.150 — 2026-10-02

### New
- Library can now run Session learning, which reviews recent sessions and proposes agents and skills.
- Proposed changes appear under Library → Suggested with a diff — apply or reject each one.

### Improved
- The Session learning schedule now defaults to UTC rather than guessing your timezone.

## 1.2.137 — 2026-10-01

### New
- Set the maximum number of sessions that can run at once, in System → Configuration.

## 1.2.136 — 2026-10-01

### Improved
- System prompt bodies in Library now render as live Markdown, like agent prompts and skills.

### Fixed
- Toned down the transcript's copy button so it doesn't compete with the time and model text.

## 1.2.135 — 2026-10-01

### New
- Copy any message in a session, and your own prompts now render as formatted Markdown.

### Improved
- The Ports page can now name the process behind a port without needing root access.
- Agent prompts and skill bodies in Library render as live Markdown too.
- System prompts moved into the Library page, alongside Agents and Skills.

## 1.2.134 — 2026-09-30

### New
- A new System → Usage page shows your Claude plan limits and what's consuming them.

## 1.2.133 — 2026-09-30

### New
- A new System → Docker page lists every container on the host, across all projects.

## 1.2.132 — 2026-09-30

### New
- A new System → Ports page shows which process owns each open port.

## 1.2.131 — 2026-09-29

### New
- The message composer shows a live Markdown preview, with a toggle for the raw source.

## 1.2.129 — 2026-09-27

### New
- A new System → Sessions dashboard lists every session across every project.

## 1.2.128 — 2026-09-27

### New
- Delete a session right from its header.

### Improved
- Every session now requires choosing an orchestrator agent.

## 1.2.127 — 2026-09-27

### Improved
- Starting a session now opens a dedicated dialog, and the Sessions list is a searchable table.

## 1.2.126 — 2026-09-27

### New
- Unsent messages are kept as a draft per session if you switch away and come back.

### Improved
- The status bar now says "Reconnecting…" when the connection drops, instead of a Live dot.

## 0.1.124 — 2026-09-27

### New
- The composer gained a Stop button for the running turn, and a session-details popover.

## 0.1.123 — 2026-09-26

### Improved
- The composer was redesigned, with image-preview tiles for attachments.

### Fixed
- Lined up the sidebar toggle and the new-tab button with the tab row.

## 0.1.122 — 2026-09-26

### Fixed
- Fixed open windows fighting over which tab row was active.

## 0.1.121 — 2026-09-26

### Fixed
- Fixed the session transcript jumping around or stalling while loading older messages.

## 0.1.120 — 2026-09-25

### Fixed
- Checkboxes in Library's agent and skill lists are back on the left, where they belong.

## 0.1.119 — 2026-09-25

### Fixed
- Fixed the Sessions page overflowing the screen on mobile.
- Docker service cards now have a consistent header on mobile.

## 0.1.118 — 2026-09-25

### Fixed
- Long session titles are now truncated instead of overflowing their row.

## 0.1.117 — 2026-09-25

### Improved
- The whole interface was redesigned with a cleaner, more consistent set of components.

## 0.1.116 — 2026-09-24

### New
- See every running code editor across sessions, with who's using it, and Stop/Open controls.

## 0.1.115 — 2026-09-24

### Fixed
- The installer no longer hangs under sudo, and now explains what the Cloudflare token is for.

## 0.1.114 — 2026-09-24

### New
- The installer can now set up HTTPS on your own domain automatically, via Let's Encrypt.

### Improved
- Every session's code editor now starts with sensible defaults — no welcome page, no AI chat.

## 0.1.109 — 2026-09-24

### New
- Sessions can open a built-in code editor in its own browser tab, scoped to that session's files.

### Fixed
- The editor launcher now shows a clear error if a restart fails, instead of hanging silently.

## 0.1.102 — 2026-09-22

### Improved
- Re-running the installer now also upgrades Claude Code, repairing a broken symlink if needed.

## 0.1.100 — 2026-09-22

### New
- Sessions show which model produced each message.

### Improved
- The model picker in Library now loads the real list of available models.

## 0.1.98 — 2026-09-16

### Fixed
- The browser skill no longer leaves stray output files in your project checkout.

## 0.1.97 — 2026-09-15

### Fixed
- Fixed the installer aborting during its Playwright setup step on a fresh server.

## 0.1.96 — 2026-09-15

### New
- Agents can now use browser and Docker skills during a session.

## 0.1.95 — 2026-09-14

### Fixed
- Fixed a project's Docker page losing track of containers scoped to a session's worktree.

## 0.1.93 — 2026-09-14

### Improved
- A session's Docker page can now target that session's own worktree, not just the project checkout.

## 0.1.91 — 2026-09-13

### New
- The installer now sets up Docker itself, keeping published container ports off the public internet.

## 0.1.90 — 2026-09-13

### New
- Each project now has a Docker page: detect, run, stream logs, and reach published ports.

## 0.1.89 — 2026-09-13

### New
- Preview an idea's generated prompt, and jump between an idea and the session it started.

## 0.1.88 — 2026-09-13

### Improved
- An idea's page now leads with the canvas; run settings moved behind a modal.

## 0.1.87 — 2026-09-13

### Fixed
- Fixed idea prompt generation stalling after one turn and sometimes losing the answer.

## 0.1.86 — 2026-09-11

### Improved
- The Ideas canvas now shows inline images and arranges itself, instead of manual ordering.

## 0.1.85 — 2026-09-08

### Fixed
- Fixed dropdown menus appearing behind an open dialog.

## 0.1.84 — 2026-09-08

### New
- A new Ideas page: lay out ideas on a canvas and hand one off to an autonomous session.

## 0.1.83 — 2026-09-07

### Improved
- Sessions in different projects now run their turns at the same time instead of queuing.

## 0.1.82 — 2026-09-07

### Fixed
- Fixed the transcript jumping when older messages loaded in above it.

## 0.1.81 — 2026-09-06

### Fixed
- Fixed the transcript fighting the page layout on a phone.

## 0.1.80 — 2026-09-06

### Fixed
- Sessions no longer break after a browser tab has gone stale.

## 0.1.79 — 2026-09-06

### Fixed
- Sessions now recover properly after a turn is cancelled or loses background work.

## 0.1.78 — 2026-09-06

### New
- Attach files to a message in a session.

### Fixed
- Attachment controls now announce the real file name to screen readers.

## 0.1.76 — 2026-09-05

### Improved
- Long transcripts now load in pages, and typing in the composer no longer lags.

## 0.1.74 — 2026-09-05

### Fixed
- Sessions recover instead of silently dying when the server runs low on memory.

## 0.1.72 — 2026-09-05

### Fixed
- New sessions now start from an up-to-date base branch instead of a stale checkout.

## 0.1.70 — 2026-09-05

### Improved
- The workspace now adapts to phones and tablets.

### Fixed
- Fixed messages failing to save when they contained certain special characters.

## 0.1.65 — 2026-09-04

### Improved
- Each transcript message now shows when it arrived.

## 0.1.64 — 2026-09-04

### New
- Export a session's transcript as a JSON file.

## 0.1.51 — 2026-09-03

### Improved
- The default agent roster now includes a tester agent, and orchestrators know their teammates.
- The built-in project-conventions skill now covers general rules, not one specific repo.

## 0.1.42 — 2026-09-03

### New
- The workspace now opens as a row of tabs, one per project, instead of a single view.

## 0.1.41 — 2026-09-02

### New
- Agents can lead a team of subagents, or work solo — set it in the agent editor in Library.

## 0.1.40 — 2026-09-02

### New
- First release: install agentoo on a bare server, add projects over SSH, and run AI agent sessions.
