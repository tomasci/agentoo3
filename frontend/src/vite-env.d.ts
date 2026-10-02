/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_APP_NAME?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Substituted by vite.config.ts's `define`, from version.json — see env.ts for
// why every read of it goes through a `typeof` guard rather than a bare
// reference.
declare const __APP_VERSION__: string

// Substituted by vite.config.ts's `define`, from the repo root's CHANGELOG.md
// + CHANGELOG.ru.md, parsed and merged at config-load time
// (features/whats-new/model/changelog-markdown.ts) — a malformed changelog
// fails `vite build`/`vite dev` itself, before this ever reaches the
// browser. Typed loosely rather than as the feature's own `Release[]`: the
// shape here is whatever the markdown parser produced, and
// model/changelog.ts is what actually validates it (through the same zod
// schema changelog.schema.ts always has), the same division as
// __APP_VERSION__ above.
declare const __CHANGELOG__: unknown
