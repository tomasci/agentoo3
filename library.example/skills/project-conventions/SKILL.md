---
name: project-conventions
description: >-
  The standing conventions every project here follows — branch naming,
  dependencies, what a comment is for, and how to handle a credential that lands
  in the conversation. Read before making changes or creating a branch.
---

# Project conventions

These rules hold across projects, so they are worth knowing before you touch
anything. They are deliberately not a description of any one codebase: how a
particular repository is laid out and what its commands are, you get from the
repository itself — its `CLAUDE.md`, its manifest, and the code next to the file
you are editing.

## Branch names

A branch is named for the day it was created and the thing it does:

```
ddMMMyy/short-kebab-name

12oct26/clinician-session-page
05oct26/fix-session-resume
```

The date is two-digit day, three-letter lowercase month, two-digit year, run
together and never separated. The name after the slash is lowercase and
hyphenated, and describes the change rather than the ticket — `add-audit-log`
tells the next person what landed; `task-4417` makes them go and look it up.

Take the date from the machine rather than from memory, because your sense of
today is whatever your context implies and it is routinely wrong:

```
date +%d%b%y | tr '[:upper:]' '[:lower:]'
```

This applies to branches *you* create. A session that already runs on a worktree
branch created for it keeps that branch — do not rename it to match this scheme.

## Conventions that matter

- Pin dependencies to exact versions rather than ranges, and commit the
  lockfile. A build that resolves differently tomorrow is a bug you cannot
  reproduce today.
- Validate at the boundary: parse what arrives from a client, a queue or the
  environment into the shape you expect rather than casting it, so a change in
  shape fails where it enters instead of three layers deeper.
- Comments explain *why*, not *what*. The code already says what it does; what
  it cannot say is the constraint, the bug, or the alternative that was tried
  and did not work.

## A pasted request is a live secret, not just a repro

When an operator pastes a snippet copied from a browser's DevTools — "copy as
fetch", "copy as cURL", a raw request with its headers — to show you a bug,
treat it the same way you would treat a password: it typically carries a live
session cookie, bearer token or CSRF header that will work against the real
backend for as long as that session is valid. That is true of any
cookie- or token-authenticated app, not a fact about one project.

Do not repeat the credential back verbatim in your response, write it into a
file, a test fixture, or a log, or leave it sitting in a report for someone
else to forward. Redact it (or describe it — "the auth cookie" — without
quoting it) before it appears anywhere outside the immediate turn, and tell the
operator plainly that what they pasted contained a live credential and what
you did about it, so they can rotate it if it already went somewhere it
shouldn't. Flag this before you act on the rest of the message, not as a
footnote after the problem is solved.
