<script lang="ts">
  import { tick } from 'svelte'
  import ComposerCommandMenu from './ComposerCommandMenu.svelte'
  import {
    caretOffset,
    domDraftKey,
    draftAnchor,
    draftKey,
    draftRuns,
    readDraft,
    renderDraft,
    setCaretOffset,
  } from '../lib/composer-document.js'
  import type { ComposerCommandState } from '../lib/composer-commands.svelte.js'

  interface Props {
    prompt: string
    commands: ComposerCommandState
    disabled?: boolean
    /** A pending user question owns Enter: it must not send or cancel the turn. */
    submitBlocked?: boolean
    placeholder?: string
    onSubmit: () => void
  }

  let {
    prompt = $bindable(), commands, disabled = false, submitBlocked = false,
    placeholder = 'Ask about your code...', onSubmit,
  }: Props = $props()

  /** The positioned box the command popup opens against. */
  let fieldElement = $state<HTMLDivElement>()
  let editorElement = $state<HTMLDivElement>()
  let composing = false
  /** Caret to restore after the next programmatic render: a completion, a cleared draft. */
  let pendingCaret: number | undefined = undefined
  /** The last caret the editor reported, so a render puts it back where it was. */
  let lastCaret = 0
  /** The draft offset of the `/` the open popup is anchored on; `undefined` when it is shut. */
  let anchoredAt: number | undefined = undefined

  /** Measure the `/` the popup is anchored on: once on the way in, and as the editor scrolls. */
  function placePopup(): void {
    const start = anchoredAt
    if (start === undefined) return
    void tick().then(() => {
      if (editorElement === undefined || fieldElement === undefined) return
      commands.anchor = draftAnchor(editorElement, fieldElement, start)
    })
  }

  export function focus(): void { editorElement?.focus() }

  /**
   * The draft is a document, not a string: the command token is a span, and the
   * DOM is the editor's own text. Typing reads the DOM and never writes it, so
   * the caret is never moved under the user; a render happens on a transition —
   * a token turning gold, a completion, a cleared draft — and restores the caret.
   */
  $effect(() => {
    const editor = editorElement
    const text = prompt
    const caret = pendingCaret
    pendingCaret = undefined
    if (editor === undefined || composing) return
    const runs = draftRuns(text, commands.catalog.commands)
    const focused = document.activeElement === editor
    if (domDraftKey(editor) === draftKey(runs) && caret === undefined) return
    renderDraft(editor, runs)
    if (caret !== undefined || focused) setCaretOffset(editor, caret ?? Math.min(lastCaret, text.length))
  })

  /** Read the editor into the draft, then decide what the popup does. */
  function refresh(): void {
    const editor = editorElement
    if (editor === undefined || composing) return
    const text = readDraft(editor)
    const caret = caretOffset(editor)
    lastCaret = caret
    if (text !== prompt) prompt = text
    commands.sync(text, caret)
    if (!commands.open) {
      anchoredAt = undefined
      return
    }
    // The popup opens on the `/` and stays there: the box is measured once, on
    // the way in, so typing the name does not walk the list across the editor.
    if (anchoredAt !== undefined) return
    anchoredAt = commands.trigger?.start ?? 0
    placePopup()
  }

  /** Write the highlighted command into the draft, shut the popup, and put the caret after it. */
  function complete(): void {
    const completed = commands.accept()
    if (completed === undefined) return
    // A click on a row fills the draft without a keystroke, so nothing else in
    // this component runs: focus the editor to leave a caret the user can type
    // at, and drop the anchor the next popup will measure afresh.
    editorElement?.focus()
    anchoredAt = undefined
    pendingCaret = completed.caret
    prompt = completed.text
  }

  function insertText(text: string): void {
    const editor = editorElement
    if (editor === undefined) return
    editor.focus()
    if (document.execCommand('insertText', false, text)) {
      refresh()
      return
    }
    const selection = window.getSelection()
    if (selection === null || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    range.deleteContents()
    const node = document.createTextNode(text)
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    refresh()
  }

  function handleKeydown(event: KeyboardEvent): void {
    // An IME in the middle of composing owns the keys; the draft is not final text.
    if (event.isComposing || composing) return
    const entering = event.key === 'Enter' && !event.shiftKey
    if (commands.open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      commands.move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (commands.open && event.key === 'Escape') {
      event.preventDefault()
      commands.close()
      return
    }
    if (commands.open && (event.key === 'Tab' || entering)) {
      if (commands.activeCommand === undefined) return
      event.preventDefault()
      complete()
      return
    }
    if (entering) {
      event.preventDefault()
      if (submitBlocked) return
      onSubmit()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      insertText('\n')
    }
  }

  /** Paste is plain text: a contenteditable takes HTML, and HTML is not a draft. */
  function handlePaste(event: ClipboardEvent): void {
    event.preventDefault()
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text.length > 0) insertText(text)
  }
</script>

<div class="composer-input" bind:this={fieldElement}>
  {#if commands.open}
    <ComposerCommandMenu
      items={commands.matches}
      active={commands.active}
      anchor={commands.anchor}
      busy={disabled}
      message={commands.emptyMessage}
      onpick={(index) => { commands.active = index; complete() }}
      onhover={(index) => { commands.active = index }}
    />
  {/if}
  <div
    class="composer-prompt"
    bind:this={editorElement}
    role="textbox"
    aria-multiline="true"
    aria-label="Prompt"
    aria-disabled={disabled || undefined}
    aria-controls={commands.open ? 'composer-command-menu' : undefined}
    aria-activedescendant={commands.open && commands.activeCommand ? `composer-command-${commands.activeCommand.name}` : undefined}
    contenteditable={disabled ? 'false' : 'true'}
    tabindex={disabled ? -1 : 0}
    spellcheck="false"
    autocapitalize="off"
    data-placeholder={placeholder}
    onkeydown={handleKeydown}
    oninput={refresh}
    onpaste={handlePaste}
    onscroll={() => { placePopup() }}
    oncompositionstart={() => { composing = true }}
    oncompositionend={() => { composing = false; refresh() }}
    onclick={refresh}
    onkeyup={refresh}
    onfocus={refresh}
    onblur={() => { commands.close(false) }}
  ></div>
</div>
