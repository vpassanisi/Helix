/**
 * Path shortening for the text the sidebar shows.
 *
 * A tool call description often quotes a file by its full path, and a full path
 * is long: `/Users/dev/Documents/Code/My Project/src/webview/components/
 * ToolCallCard.svelte` fills the narrow sidebar before the words that explain
 * the call. The card truncates with a CSS ellipsis, which keeps the head of the
 * line, so the reader sees the drive letter and the user folder and never sees
 * the file the call touched.
 *
 * This module shortens each path inside a line from the front instead: the tail
 * carries the identity, so `…/components/ToolCallCard.svelte` says more in
 * fewer characters. It changes display text only. The full line stays available
 * for a tooltip, and nothing here changes what is sent to the Host.
 */

/** Segments kept at the end of a shortened path: the file and its parent folder. */
export const PATH_TAIL_SEGMENTS = 2

/** A path needs more segments than the tail shows to be worth shortening. */
const MIN_SEGMENTS = PATH_TAIL_SEGMENTS + 2

const singleQuote = "'"
const doubleQuote = '"'
const backtick = '`'

/**
 * The characters a path may start after. A path must begin at the start of the
 * text or after one of these, which is what stops `https://example.com/a/b/c`
 * from matching: its first slash follows a colon, and a colon is not here.
 */
const startBoundary = `^|[\\s([{<${singleQuote}${doubleQuote}${backtick}]`

/**
 * The characters that end a path inside a sentence, beyond whitespace and the
 * separator itself. Quotes, brackets, angle brackets, a glob wildcard, a pipe,
 * a colon, and a comma or semicolon in either script.
 */
const endBoundary = `${singleQuote}${doubleQuote}${backtick}<>"|?*,:;)\\]}，；`

/**
 * One path segment: a run of characters with no separator in it and no
 * character that ends a phrase. A POSIX path is split by `/`, a Windows path by
 * `\`, so each pattern drops its own separator from the segment class.
 */
const posixSegment = `[^\\s/\\\\${endBoundary}]+`
const windowsSegment = `[^\\s\\\\/${endBoundary}]+`

/**
 * A POSIX path: absolute (`/a/b/c`), home-relative (`~/a/b`), or dot-relative
 * (`./a/b`, `../a/b`). At least one folder must come before the last segment.
 */
const posixPath = new RegExp(`(${startBoundary})((?:~|\\.{1,2})?\\/(?:${posixSegment}/)+${posixSegment})`, 'g')

/** A Windows path: a drive (`C:\a\b`) or a share (`\\server\share\a\b`). */
const windowsPath = new RegExp(`(${startBoundary})((?:[A-Za-z]:\\\\|\\\\\\\\[^\\\\]+\\\\[^\\\\]+\\\\)(?:${windowsSegment}\\\\)+${windowsSegment})`, 'g')

/**
 * Keep the last `PATH_TAIL_SEGMENTS` segments of one path and mark the front
 * with an ellipsis. A path the tail already shows in full is returned as it is.
 */
function shortenOne(path: string, separator: '/' | '\\'): string {
  const segments = path.split(separator).filter((entry) => entry !== '')
  if (segments.length < MIN_SEGMENTS) return path
  return `\u2026${separator}${segments.slice(-PATH_TAIL_SEGMENTS).join(separator)}`
}

function shortenMatches(text: string, pattern: RegExp, separator: '/' | '\\'): string {
  return text.replace(pattern, (_all, boundary: string, path: string) => `${boundary}${shortenOne(path, separator)}`)
}

/**
 * Shorten every file path in a line of display text.
 *
 * Text that is not a path passes through untouched, and a line with no long
 * path is returned unchanged.
 */
export function shortenPaths(text: string): string {
  if (text === '') return text
  return shortenMatches(shortenMatches(text, posixPath, '/'), windowsPath, '\\')
}
