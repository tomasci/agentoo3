// Where a new session's worktree starts from.
//
// Precedence for the branch itself is override > project.defaultBranch > the
// repo's own current branch — see planBaseBranch below. Bringing that branch
// up to date is a separate step, and is allowed to fail quietly (see the
// `note` field); choosing a branch that turns out not to exist anywhere is
// not, and fails the whole request before a session row is even inserted.

import { checkedOutBranch, fetchBranch, git, remoteUrl, revParse } from '@/lib/git'

const REMOTE = 'origin'

export type BaseBranchPlan =
  | { ok: true; branch: string | null; startPoint: string | null; note?: string }
  | { ok: false; reason: string }

/**
 * Decide what a new session's worktree should be cut from, fetching the
 * chosen branch from `origin` first so the worktree starts from what is
 * actually on the remote rather than whatever the shared checkout last
 * happened to have lying around.
 *
 * Two outcomes share the `ok: true` shape on purpose: a project with no
 * branch configured at all (`branch: null, startPoint: null`) and a branch
 * that was found and resolved cleanly. Both cut a worktree the ordinary way;
 * only the first passes no start point to `addWorktree`, letting git fall
 * back to HEAD — or infer `--orphan` on one that is still unborn, which is
 * how a brand new empty project gets its first session at all.
 *
 * `ok: false` is reserved for the one case that has to stop session creation
 * before a row exists: the requested branch resolves to nothing at all,
 * neither locally nor on the remote. Every other failure along the way — no
 * remote configured, the network being down, a rejected key, a fetch
 * timeout, a concurrent fetch holding the ref lock, or the branch existing
 * locally but not on the remote — degrades to the local ref instead, because
 * in each of those cases a correct answer still exists on disk; only "there
 * is no correct answer anywhere" is worth failing the request over. Isolation
 * has always degraded gracefully here (see createSession); this keeps that
 * posture for staleness but not for picking a different branch than the one
 * asked for, which would hand back code the caller never agreed to run.
 *
 * `options` passes straight through to `fetchBranch`: `sshCommand` is how a
 * caller supplies the project's own deploy key (see fetchBranch's docstring
 * for why this function does not resolve one itself), and `timeoutMs` exists
 * mainly so a test can shrink the 20s production default rather than pay it
 * on every case that exercises a degrade.
 */
export async function planBaseBranch(
  repoPath: string,
  requested: { override?: string; projectDefault: string | null },
  options: { timeoutMs?: number; sshCommand?: string } = {},
): Promise<BaseBranchPlan> {
  const branch =
    requested.override ?? requested.projectDefault ?? (await checkedOutBranch(repoPath))

  // Nothing to base this session on: today's behaviour for a project with no
  // default branch and a session with no override, unborn HEAD included.
  if (!branch) return { ok: true, branch: null, startPoint: null }

  const localRef = `refs/heads/${branch}`
  const remoteRef = `refs/remotes/${REMOTE}/${branch}`

  const hasRemote = Boolean(await remoteUrl(repoPath))
  let degradeReason: string | undefined

  if (hasRemote) {
    const fetch = await fetchBranch(repoPath, REMOTE, branch, options)
    if (!fetch.ok) degradeReason = fetch.stderr || `git fetch ${REMOTE} ${branch} failed`
  }
  // No remote at all is not a failure and gets no note: an `empty` project, or
  // one adopted before it ever had a remote configured, has nothing to fetch,
  // and the local ref genuinely is the latest code there is.

  if (degradeReason) {
    // A failed fetch never touches refs/remotes/<remote>/<branch> — git
    // leaves it exactly as it was — so the only trustworthy start point left
    // is the local branch, if the branch is there at all.
    const local = await revParse(repoPath, localRef)
    if (!local) {
      return {
        ok: false,
        reason:
          `Branch "${branch}" does not exist locally or on ${REMOTE}, and could not be ` +
          `fetched: ${degradeReason}`,
      }
    }
    return {
      ok: true,
      branch,
      startPoint: localRef,
      note:
        `Could not update "${branch}" from ${REMOTE} before starting this session ` +
        `(${degradeReason}). Started from the local branch instead, which may be behind.`,
    }
  }

  if (!hasRemote) {
    const local = await revParse(repoPath, localRef)
    if (!local) {
      return {
        ok: false,
        reason: `Branch "${branch}" does not exist, and this project has no remote to fetch it from`,
      }
    }
    return { ok: true, branch, startPoint: localRef }
  }

  // Fetched cleanly. Prefer the freshly fetched remote-tracking ref — that is
  // the whole point of fetching — except when the local branch already
  // contains it: an adopted project where a human commits locally and pushes
  // only occasionally would otherwise have every new session silently drop
  // those unpushed commits from its starting point.
  const remoteSha = await revParse(repoPath, remoteRef)
  if (!remoteSha) {
    // The explicit refspec above should make this unreachable when the fetch
    // itself reported success, but a start point still has to come from
    // somewhere if it somehow happens.
    const local = await revParse(repoPath, localRef)
    if (!local) {
      return { ok: false, reason: `Branch "${branch}" does not exist on ${REMOTE} after fetching` }
    }
    return { ok: true, branch, startPoint: localRef }
  }

  const ahead = await git(['merge-base', '--is-ancestor', remoteRef, localRef], repoPath)
  return { ok: true, branch, startPoint: ahead.ok ? localRef : remoteRef }
}
