import { escapeHtml, isRecord } from './value-utils.js'

/**
 * Composer slash commands.
 *
 * The name grammar mirrors the Harness command registry so a line the composer
 * accepts is a line the Host resolves: a leading slash, a lowercase name, and
 * whitespace (or end of line) after it.
 */
const COMMAND_LINE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/

/** One registered command, as the composer lists it. */
export interface ComposerCommand {
  name: string
  description: string
  /** Free-form argument hint, e.g. `[off|message]`. */
  hint?: string
  /** Where the command came from, for the row's origin label. */
  source?: 'harness' | 'workspace'
}

export interface CommandCatalog {
  commands: ComposerCommand[]
  /** False when the runtime refused the catalog: the composer hides the popup. */
  available: boolean
}

export interface CommandInvocation {
  name: string
  /** Everything after the command name, trimmed. */
  args: string
}

/** One settled command run, as the Host registry normalizes it. */
export interface CommandResult {
  kind: 'success' | 'error'
  text?: string
  commandId?: string
}

/** The `/name` token the caret is inside, while the composer is naming a command. */
export interface SlashTrigger {
  start: number
  /** Exclusive; the end of the name token. */
  end: number
  /** The typed name so far, without the slash. */
  query: string
}

/** The command token a finished line resolves to, for the gold composer text. */
export interface CommandToken {
  start: number
  end: number
  command: ComposerCommand
}

export type CommandScore = 'exact' | 'prefix' | 'word' | 'substring' | 'sequence' | 'description'

const RANK: CommandScore[] = ['exact', 'prefix', 'word', 'substring', 'sequence', 'description']

export function isCommandName(value: string): boolean {
  return COMMAND_NAME.test(value)
}

export function isComposerCommand(value: unknown): value is ComposerCommand {
  return isRecord(value) && typeof value.name === 'string' && isCommandName(value.name)
    && typeof value.description === 'string'
    && (value.hint === undefined || typeof value.hint === 'string')
    && (value.source === undefined || value.source === 'harness' || value.source === 'workspace')
}

export function isCommandCatalog(value: unknown): value is CommandCatalog {
  return isRecord(value) && typeof value.available === 'boolean' && Array.isArray(value.commands)
    && value.commands.every(isComposerCommand)
}

/** Resolve a full composer line, exactly as the Host registry would. */
export function parseCommandInvocation(line: string): CommandInvocation | undefined {
  const match = COMMAND_LINE.exec(line)
  if (match === null) return undefined
  return { name: match[1], args: line.slice(match[0].length).trim() }
}

/** The Host form of an invocation: name, then the arguments verbatim. */
export function commandLine(name: string, args: string): string {
  return args ? `/${name} ${args}` : `/${name}`
}

/**
 * A run command as a transcript line: the `/name` token in a gold span, the
 * arguments as escaped text. Both parts are escaped, so the markup is safe.
 */
export function commandLineHtml(name: string, args: string): string {
  const token = escapeHtml(commandLine(name, ''))
  return `<span class="message-command-token">${token}</span>${escapeHtml(args ? ` ${args}` : '')}`
}

/**
 * The command token the caret sits in. A command only counts at the very start
 * of the composer, and only while the caret is on the name itself — moving past
 * the whitespace into the arguments closes the popup.
 */
export function slashTrigger(text: string, caret: number): SlashTrigger | undefined {
  if (text.startsWith('/')) {
    const terminator = text.search(/[\t\n\r ]/)
    const end = terminator === -1 ? text.length : terminator
    if (caret > 0 && caret <= end) return { start: 0, end, query: text.slice(1, end) }
  }
  return undefined
}

/**
 * The popup's open rule: the `/name` token under the caret, until that token has
 * been completed to a command or dismissed. Completing a command settles the
 * draft the popup is measured against, which is what shuts it.
 */
export function commandPopupOpen(text: string, caret: number, dismissed: string | undefined): boolean {
  const trigger = slashTrigger(text, caret)
  return trigger !== undefined && trigger.query !== dismissed
}

/** The command a finished line runs, when its leading token is a known command. */
export function resolveCommandToken(text: string, commands: readonly ComposerCommand[]): CommandToken | undefined {
  const invocation = parseCommandInvocation(text)
  if (invocation === undefined) return undefined
  const command = commands.find((entry) => entry.name === invocation.name)
  if (command === undefined) return undefined
  return { start: 0, end: commandLine(command.name, '').length, command }
}

/** Rank the catalog for a typed query, best match first. */
export function filterCommands(commands: readonly ComposerCommand[], query: string): ComposerCommand[] {
  const term = query.trim().toLowerCase()
  if (!term) return [...commands].sort(byName)
  const scored = commands
    .map((command) => ({ command, score: scoreCommand(command, term) }))
    .filter((entry): entry is { command: ComposerCommand; score: CommandScore } => entry.score !== undefined)
  return scored
    .sort((left, right) => RANK.indexOf(left.score) - RANK.indexOf(right.score)
      || left.command.name.length - right.command.name.length || byName(left.command, right.command))
    .map((entry) => entry.command)
}

function scoreCommand(command: ComposerCommand, term: string): CommandScore | undefined {
  const name = command.name.toLowerCase()
  if (name === term) return 'exact'
  if (name.startsWith(term)) return 'prefix'
  if (name.split(/[-_]/).some((part) => part.startsWith(term))) return 'word'
  if (name.includes(term)) return 'substring'
  if (isSubsequence(name, term)) return 'sequence'
  if (command.description.toLowerCase().includes(term)) return 'description'
  return undefined
}

function isSubsequence(name: string, term: string): boolean {
  let index = 0
  for (const character of name) {
    if (character === term[index]) index += 1
    if (index === term.length) return true
  }
  return false
}

function byName(left: ComposerCommand, right: ComposerCommand): number {
  return left.name.localeCompare(right.name)
}

/**
 * Complete the typed token with a chosen command. The composer is left with a
 * resolved command plus one space, ready for arguments.
 */
export function completeCommand(
  text: string,
  caret: number,
  command: ComposerCommand,
): { text: string; caret: number } {
  const trigger = slashTrigger(text, caret) ?? { start: 0, end: text.length }
  const completed = `/${command.name}`
  const needsSpace = command.hint !== undefined || text.slice(trigger.end).trimStart().length > 0
  return {
    text: `${text.slice(0, trigger.start)}${completed}${needsSpace ? ' ' : ''}${text.slice(trigger.end).replace(/^\s+/, '')}`,
    caret: trigger.start + completed.length + (needsSpace ? 1 : 0),
  }
}
