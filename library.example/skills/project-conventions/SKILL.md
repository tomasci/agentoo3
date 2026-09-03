---
name: project-conventions
description: The standing conventions every project here follows — branch naming, dependencies, and what a comment is for. Read before making changes or creating a branch.
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
