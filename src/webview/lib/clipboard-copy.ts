/**
 * Copy support for the sidebar.
 *
 * VS Code takes the copy keypress inside a webview. The keybinding handler VS
 * Code injects in the webview frame calls `preventDefault` on Cmd+C, which
 * blocks the browser's own copy, and forwards the keypress to the workbench.
 * The workbench runs the editor copy command. That command acts on the webview
 * VS Code tracks as focused, and when the tracking is not current the command
 * copies nothing: the keypress is spent and the selection never reaches the OS
 * clipboard.
 *
 * The answer runs in the webview. This listener sits on the window in the
 * capture phase, which fires before the handler VS Code registers on the frame
 * window, and it copies the selection itself. With no selection the keypress is
 * left alone, so the webview takes nothing from VS Code that it cannot serve.
 */

/** The parts of a keypress that decide whether it is the copy chord. */
export interface CopyKey {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * True when the keypress is the copy chord for this platform. macOS answers to
 * Cmd+C and Ctrl+C, which is the chord VS Code intercepts; every other platform
 * answers to Ctrl+C. A chord with Shift or Alt is a different command, and VS
 * Code does not intercept it, so it stays with VS Code.
 */
export function isCopyKey(event: CopyKey, platform: string): boolean {
  if (event.key.length !== 1 || event.key.toLowerCase() !== 'c') return false
  if (event.shiftKey || event.altKey) return false
  if (/Mac|iPhone|iPad|iPod/.test(platform)) return event.metaKey || event.ctrlKey
  return event.ctrlKey
}

/** A field that reports its own selection: an `<input>` or a `<textarea>`. */
interface FieldLike {
  tagName: string
  value: string
  selectionStart: number
  selectionEnd: number
}

function isField(target: EventTarget | null): target is EventTarget & FieldLike {
  if (target === null) return false
  const field = target as unknown as FieldLike
  return (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') &&
    typeof field.value === 'string' &&
    typeof field.selectionStart === 'number' &&
    typeof field.selectionEnd === 'number'
}

/** The selected text inside an `<input>` or a `<textarea>`. */
function fieldSelection(target: EventTarget | null): string {
  if (!isField(target)) return ''
  const from = Math.min(target.selectionStart, target.selectionEnd)
  const to = Math.max(target.selectionStart, target.selectionEnd)
  return target.value.slice(from, to)
}

/**
 * The text the keypress should put on the clipboard, and `''` when there is
 * none. The field the keypress targets answers first: Chromium does not expose
 * an `<input>` selection through the Selection API, so the field has to report
 * its own. Everything else, including a contenteditable draft and the
 * transcript, answers through the document selection.
 */
export function copyTextFor(target: EventTarget | null, selection: Selection | null): string {
  const inField = fieldSelection(target)
  if (inField.length > 0) return inField
  if (selection === null || selection.isCollapsed) return ''
  return selection.toString()
}

/**
 * Put `text` on the OS clipboard. The document copy command is the primary
 * path: it writes the live selection, so a rich selection keeps its content,
 * and it needs no clipboard permission. The async clipboard API is the
 * fallback for a document that refuses the command.
 */
function writeToClipboard(document: Document, text: string): void {
  let commanded = false
  try {
    commanded = document.execCommand('copy')
  } catch {
    commanded = false
  }
  if (commanded) return
  void navigator.clipboard?.writeText(text).catch(() => undefined)
}

/**
 * Teach the webview to answer the copy chord (Cmd+C and Ctrl+C on macOS,
 * Ctrl+C elsewhere) with the selection the reader made in it. Call once, at
 * startup. The returned function removes the listener.
 */
export function installWebviewCopySupport(target: Window & typeof globalThis = window): () => void {
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!isCopyKey(event, target.navigator.userAgent)) return
    const text = copyTextFor(event.target, target.document.getSelection())
    if (text.length === 0) return
    /* Keep the keypress here: the handler VS Code registers on the frame window
       never sees it, and the browser does not run a second copy. */
    event.preventDefault()
    event.stopImmediatePropagation()
    writeToClipboard(target.document, text)
  }

  target.addEventListener('keydown', handleKeyDown, true)
  return () => target.removeEventListener('keydown', handleKeyDown, true)
}
