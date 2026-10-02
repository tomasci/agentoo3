import type { EnvFile } from '../hooks/use-env-files'

export interface EnvFileGroup {
  /** `''` for the project root; every other value is a POSIX-relative
   * folder with no trailing slash (e.g. `"server"`, `"docker/dev"`). */
  folder: string
  files: EnvFile[]
}

/**
 * Groups files by their containing folder, so the store's flat list reads as
 * the tree it actually is — a root `.env` next to a `server/.env` next to a
 * `webapp/.env` is three unrelated-looking rows otherwise.
 *
 * Folders are sorted alphabetically with the root always first: `''` is a
 * prefix of every string, so a plain sort already puts it ahead of any named
 * folder. Not simply the server's own path order (`listEnvFiles` sorts whole
 * paths) — a root file named e.g. "zz.env" would otherwise sort after
 * "aaa/.env" and split the root group in two.
 */
export function groupEnvFilesByFolder(files: EnvFile[]): EnvFileGroup[] {
  const byFolder = new Map<string, EnvFile[]>()
  for (const file of files) {
    const slash = file.path.lastIndexOf('/')
    const folder = slash === -1 ? '' : file.path.slice(0, slash)
    const group = byFolder.get(folder)
    if (group) group.push(file)
    else byFolder.set(folder, [file])
  }
  return [...byFolder.keys()]
    .sort()
    .map((folder) => ({ folder, files: byFolder.get(folder) as EnvFile[] }))
}
