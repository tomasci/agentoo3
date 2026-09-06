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
