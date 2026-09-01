/**
 * True when a string contains a C0 or C1 control character.
 *
 * Deliberately a char-code scan rather than a regex: a character class spelling
 * out this range either embeds raw control bytes in the source (fragile, and
 * invisible in review) or trips Biome's noControlCharactersInRegex rule, which
 * exists precisely to catch the accidental version of this.
 *
 * Control characters are rejected wherever operator input reaches a subprocess
 * argument or a filesystem path, since they are how payloads get smuggled past
 * shape checks.
 */
export function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    // C0 (0x00-0x1F), DEL (0x7F), and C1 (0x80-0x9F).
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}
