/**
 * The https equivalent of an ssh git remote, when there is one.
 *
 * Worth offering because SSH is never anonymous: GitHub, GitLab and Bitbucket
 * all require a key on their ssh endpoint even for a public repository. Cloning
 * a public repo over https needs no credential at all, so for a public repo
 * switching the remote is a simpler fix than provisioning a deploy key.
 *
 *   git@github.com:user/repo.git        -> https://github.com/user/repo.git
 *   ssh://git@github.com/user/repo.git  -> https://github.com/user/repo.git
 */
export function httpsEquivalent(remote: string | null): string | null {
  if (!remote) return null

  // scp-like: user@host:path
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(.+)$/.exec(remote)
  if (scp) return `https://${scp[1]}/${scp[2]}`

  const ssh = /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/(.+)$/.exec(remote)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`

  return null
}

export const isSshRemote = (remote: string | null): boolean =>
  Boolean(remote) && httpsEquivalent(remote) !== null
