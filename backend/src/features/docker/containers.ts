// The union-and-inspect step both GET /projects/{id}/docker and the
// pre-delete teardown gate in sessions/service.ts need — extracted to its own
// leaf module so that gate can call it directly without an import cycle: this
// file reaches into names.ts, inspect.ts and cli.ts only, never
// projects/service.ts or sessions/service.ts. (sessions/service.ts -> here is
// fine; here -> sessions/service.ts would not be.)

import { type DockerCli, realDockerCli } from './cli'
import type { DockerContainer } from './inspect'
import { inspectContainersRaw, listContainerIds, toDockerContainer } from './inspect'
import type { DockerScopeRef } from './names'
import { composeProjectLabelFilter, projectLabelFilter } from './names'

/**
 * Every container that belongs to one scope: the union of containers labelled
 * for its compose stack and containers labelled for its plain-Dockerfile
 * path, narrowed to the ones actually belonging to *this* scope.
 *
 * The narrowing matters once more than one scope exists for a project:
 * `com.agentoo.project` (the plain-Dockerfile label) carries only the slug,
 * not the session — a docker label filter cannot express "and no session
 * label at all" — so without it, a worktree scope's `projectLabelFilter`
 * query would also return the repo scope's plain-Dockerfile container, and
 * vice versa.
 *
 * Narrowed by the `com.agentoo.session` label, not by name. A name comparison
 * (`c.name === containerName(ref)`) used to do this and was wrong two ways:
 * it silently dropped a container that legitimately carries
 * `com.agentoo.project=<slug>` but was renamed or hand-labelled rather than
 * started by this dashboard (this is the *only* thing standing between a
 * project and every plain-Dockerfile container matching its label, so
 * "no-op at repo scope" was never actually true); and a project slug that
 * happens to read like `<other-slug>_s-<hex12>` could forge another scope's
 * *name* even though `com.agentoo.session` — a label this feature alone ever
 * sets — could not be forged the same way (see names.ts's own header for the
 * collision this closes the other arm of). Reading the label this feature
 * itself controls is strictly more robust than matching a string a client
 * never touches but a slug still could.
 */
export async function listScopeContainers(
  ref: DockerScopeRef,
  cli: DockerCli = realDockerCli,
): Promise<DockerContainer[]> {
  const composeIds = new Set(await listContainerIds(composeProjectLabelFilter(ref), cli))
  const projectIds = await listContainerIds(projectLabelFilter(ref.slug), cli)
  const allIds = new Set([...composeIds, ...projectIds])
  const rawContainers = await inspectContainersRaw([...allIds], cli)
  const owned = rawContainers.filter((raw) => {
    if (composeIds.has(raw.Id)) return true
    // Already known to carry `com.agentoo.project=<slug>` — that is what
    // `projectIds` was filtered on — so the only thing left to check is
    // whether it belongs to *this* scope's session, or (repo scope) no
    // session at all.
    const session = raw.Config?.Labels?.['com.agentoo.session']
    return ref.sessionId === null ? session === undefined : session === ref.sessionId
  })
  return owned.map(toDockerContainer)
}
