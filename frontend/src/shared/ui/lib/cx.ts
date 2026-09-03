// Mandatory joiner inside shared/ui/**: template-literal joining left 25 sites
// with hand-rolled truthiness checks that were each subtly different.
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
