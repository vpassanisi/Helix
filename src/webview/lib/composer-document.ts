import { resolveCommandToken, type ComposerCommand } from '../../shared/commands.js'

/**
 * The composer draft as a document, not a string.
 *
 * `Run` is deliberately small: plain text, and a leading token that resolves to
 * a command. Chip kinds (file mentions, attachments, skill chips) are added here
 * and the editor, the popup anchor, and the serialised line pick them up without
 * touching the wire protocol.
 */
export type ComposerRun =
  | { kind: 'text'; text: string }
  | { kind: 'command'; text: string; command: ComposerCommand }

const COMMAND_CLASS = 'text-[var(--brand-gold)]'
const BLOCK = /^(DIV|P|LI|BLOCKQUOTE|H[1-6]|PRE)$/

/** The composer draft as runs: a leading token naming a known command is one run. */
export function draftRuns(text: string, commands: readonly ComposerCommand[]): ComposerRun[] {
  const token = resolveCommandToken(text, commands)
  if (token === undefined) return [{ kind: 'text', text }]
  const runs: ComposerRun[] = []
  if (token.start > 0) runs.push({ kind: 'text', text: text.slice(0, token.start) })
  runs.push({ kind: 'command', text: text.slice(token.start, token.end), command: token.command })
  if (token.end < text.length) runs.push({ kind: 'text', text: text.slice(token.end) })
  return runs
}

export function serializeRuns(runs: readonly ComposerRun[]): string {
  return runs.map((run) => run.text).join('')
}

/** The runs the editor shows, with adjacent plain text merged into one span. */
export function editorRuns(runs: readonly ComposerRun[]): ComposerRun[] {
  const merged: ComposerRun[] = []
  for (const run of runs) {
    if (run.text.length === 0) continue
    const last = merged[merged.length - 1]
    if (last !== undefined && last.kind === 'text' && run.kind === 'text') last.text += run.text
    else merged.push({ ...run })
  }
  return merged
}

/**
 * One piece of the editor's content: a text node with its text, or a synthetic
 * `\n` for a `<br>` or a block boundary, which has no text node of its own.
 * Offsets in the draft are counted over these slices, so the caret lands where
 * the serialised text says it should.
 */
interface DraftSlice {
  node: Text | null
  text: string
}

function draftSlices(container: HTMLElement): DraftSlice[] {
  const slices: DraftSlice[] = []
  const walk = (node: Node): void => {
    for (const child of node.childNodes) {
      if (child instanceof HTMLBRElement) {
        // A `<br>` that ends its parent is Chromium's filler for the empty line
        // the caret sits on; it is not a newline of the draft.
        if (child === node.lastChild) continue
        slices.push({ node: null, text: '\n' })
        continue
      }
      if (child instanceof HTMLElement) {
        // A block starts a line of its own; the first child of the editor does not.
        if (BLOCK.test(child.tagName) && slices.length > 0) slices.push({ node: null, text: '\n' })
        walk(child)
        continue
      }
      if (child instanceof Text) {
        const text = child.textContent ?? ''
        if (text.length > 0) slices.push({ node: child, text })
      }
    }
  }
  walk(container)
  return slices
}

/** The editor's content as the draft string the wire protocol sends. */
export function readDraft(container: HTMLElement): string {
  return draftSlices(container).map((slice) => slice.text).join('')
}

/**
 * Render the runs into the editor: text nodes in spans, newlines as `<br>`,
 * `white-space: pre-wrap` carrying the spaces. Rebuilding is cheap at composer
 * sizes and only happens on a transition, never on every keystroke.
 */
export function renderDraft(container: HTMLElement, runs: readonly ComposerRun[]): void {
  const fragment = document.createDocumentFragment()
  for (const run of editorRuns(runs)) {
    const parts = run.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) fragment.append(document.createElement('br'))
      if (part.length === 0) return
      const span = document.createElement('span')
      span.append(document.createTextNode(part))
      if (run.kind === 'command') span.className = COMMAND_CLASS
      fragment.append(span)
    })
  }
  container.replaceChildren(fragment)
}

/** A draft key that changes when the text or a run's styling changes. */
export function draftKey(runs: readonly ComposerRun[]): string {
  return editorRuns(runs).map((run) => `${run.kind === 'command' ? 'c' : 't'}\u0000${run.text}`).join('\u0001')
}

/** A key no draft key can equal: the DOM is not the shape the renderer built. */
const STRAY_DOM_KEY = '\u0000stray'

/**
 * A shape `renderDraft` builds: a plain span, or the gold token span.
 *
 * Deleting a gold token in one selection leaves Chromium's typing style on its
 * colour, and the characters typed after it arrive wrapped in a `<font color>`
 * or a `<span style>`. A key that reads only the token class calls that plain
 * text, the render is skipped, and the text stays gold.
 *
 * Only a text node's own parent is judged. A block element is a line of the
 * draft — the slices count it as a newline — and rebuilding on the sight of one
 * moves the caret to a stale offset and merges the line the user is typing on.
 */
export function canonicalRenderedElement(tagName: string, attributeNames: readonly string[]): boolean {
  return tagName === 'SPAN'
    && (attributeNames.length === 0 || (attributeNames.length === 1 && attributeNames[0] === 'class'))
}

const attributeNamesOf = (element: Element): string[] =>
  Array.from(element.attributes, (attribute) => attribute.name)

/** The draft key of what the editor currently holds, for the render comparison. */
export function domDraftKey(container: HTMLElement): string {
  const runs: ComposerRun[] = []
  for (const slice of draftSlices(container)) {
    if (slice.node === null) {
      const last = runs[runs.length - 1]
      if (last === undefined) runs.push({ kind: 'text', text: '\n' })
      else last.text += '\n'
      continue
    }
    const parent = slice.node.parentElement
    // Text sitting in the editor itself is the caret's own; a wrapper is styling.
    if (parent !== null && parent !== container && !canonicalRenderedElement(parent.tagName, attributeNamesOf(parent))) {
      return STRAY_DOM_KEY
    }
    const styled = parent?.classList.contains(COMMAND_CLASS) === true
    const last = runs[runs.length - 1]
    if (last !== undefined && (styled ? last.kind !== 'command' : last.kind !== 'text')) {
      runs.push({ kind: styled ? 'command' : 'text', text: slice.text } as ComposerRun)
      continue
    }
    if (last === undefined) {
      runs.push({ kind: styled ? 'command' : 'text', text: slice.text } as ComposerRun)
      continue
    }
    last.text += slice.text
  }
  return draftKey(runs)
}

/** Caret position as an offset into the draft, counting `<br>` as one newline. */
export function caretOffset(container: HTMLElement): number {
  const selection = window.getSelection()
  if (selection === null || selection.rangeCount === 0) return readDraft(container).length
  const node = selection.focusNode ?? selection.anchorNode
  const offset = selection.focusOffset ?? selection.anchorOffset
  const slices = draftSlices(container)
  let total = 0
  for (const slice of slices) {
    if (slice.node === node) return total + Math.min(offset, slice.text.length)
    if (node === container && slice.node !== null) {
      // The caret sits between two children of the editor.
      const index = Array.prototype.indexOf.call(container.childNodes, slice.node)
      if (index >= offset) return total
    }
    total += slice.text.length
  }
  return total
}

/** Put the caret at a draft offset, at the end when the offset runs past the content. */
export function setCaretOffset(container: HTMLElement, offset: number): void {
  const selection = window.getSelection()
  if (selection === null) return
  const range = document.createRange()
  let total = 0
  let previous: Text | null = null
  for (const slice of draftSlices(container)) {
    if (slice.node === null) {
      // A newline: land at the end of the line it ends.
      if (offset <= total && previous !== null) {
        range.setStartAfter(previous)
        selection.removeAllRanges()
        selection.addRange(range)
        return
      }
    } else if (offset <= total + slice.text.length) {
      range.setStart(slice.node, Math.max(0, offset - total))
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
    total += slice.text.length
    previous = slice.node
  }
  range.selectNodeContents(container)
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}

/** A range's box relative to the positioned field; an unmapped range anchors at the origin. */
function measure(range: Range, container: HTMLElement, field: HTMLElement): { x: number; y: number } {
  if (!container.contains(range.startContainer)) return { x: 0, y: 0 }
  const rect = range.getBoundingClientRect()
  if (rect.height === 0 && rect.width === 0 && rect.x === 0 && rect.y === 0) return { x: 0, y: 0 }
  const box = field.getBoundingClientRect()
  return {
    x: Math.max(0, rect.left - box.left),
    y: Math.max(0, rect.top - box.top),
  }
}

/**
 * The box of the character at a draft offset, relative to the composer field.
 * Measuring a glyph, not the collapsed caret, is the point: the command popup
 * opens on the `/` and stays there while the name is typed out, instead of
 * chasing the caret.
 */
export function draftAnchor(container: HTMLElement, field: HTMLElement, offset: number): { x: number; y: number } {
  const range = document.createRange()
  let total = 0
  let previous: Text | null = null
  for (const slice of draftSlices(container)) {
    if (slice.node === null) {
      // A newline: anchor at the end of the line it ends.
      if (offset <= total && previous !== null) {
        range.setStartAfter(previous)
        range.collapse(true)
        return measure(range, container, field)
      }
      total += slice.text.length
      continue
    }
    if (offset < total + slice.text.length) {
      const index = offset - total
      range.setStart(slice.node, index)
      range.setEnd(slice.node, Math.min(index + 1, slice.text.length))
      return measure(range, container, field)
    }
    total += slice.text.length
    previous = slice.node
  }
  // Nothing sits at that offset — an empty draft: the head of the editor.
  range.selectNodeContents(container)
  range.collapse(true)
  return measure(range, container, field)
}
