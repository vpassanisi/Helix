/// <reference lib="dom" />

/** Serialized into an isolated browser world. Keep this function self-contained. */
function installPicker(bindingName: string, cleanupName: string, maxCharacters: number): void {
  const globals = globalThis as unknown as Record<string, ((value?: string) => void) | undefined>
  globals[cleanupName]?.()
  const send = (value: unknown) => globals[bindingName]?.(JSON.stringify(value))
  const root = document.createElement('div')
  root.setAttribute('data-helix-picker', '')
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;'
  const shadow = root.attachShadow({ mode: 'closed' })
  const outline = document.createElement('div')
  outline.style.cssText = 'display:none;position:fixed;box-sizing:border-box;border:2px solid #3b82f6;background:rgba(59,130,246,.08);pointer-events:none;'
  const label = document.createElement('div')
  label.style.cssText = 'position:absolute;left:-2px;top:100%;max-width:350px;padding:3px 6px;background:#2563eb;color:white;font:12px/18px sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:3px;'
  outline.append(label)
  shadow.append(outline)
  document.documentElement.append(root)
  let hovered: Element | undefined
  let pointer: { x: number; y: number } | undefined
  let animation = 0
  let live = true
  const shortLabel = (element: Element) => element.tagName.toLowerCase() + (element.id ? `#${element.id}` : '') + Array.from(element.classList).slice(0, 3).map((name) => `.${name}`).join('')
  const targetOf = (event: Event) => event.composedPath().find((item): item is Element => item instanceof Element && item !== root)
  const draw = () => {
    if (!live) return
    if (pointer) {
      let target = document.elementFromPoint(pointer.x, pointer.y)
      while (target?.shadowRoot) {
        const inner = target.shadowRoot.elementFromPoint(pointer.x, pointer.y)
        if (!inner || inner === target) break
        target = inner
      }
      hovered = target ?? undefined
    }
    if (hovered?.isConnected) {
      const rect = hovered.getBoundingClientRect()
      outline.style.display = 'block'
      outline.style.left = `${rect.left}px`
      outline.style.top = `${rect.top}px`
      outline.style.width = `${rect.width}px`
      outline.style.height = `${rect.height}px`
      label.textContent = shortLabel(hovered)
      label.style.top = rect.bottom + 26 > innerHeight ? 'auto' : '100%'
      label.style.bottom = rect.bottom + 26 > innerHeight ? '100%' : 'auto'
    } else outline.style.display = 'none'
    animation = requestAnimationFrame(draw)
  }
  const move = (event: Event) => {
    hovered = targetOf(event)
    if (event instanceof PointerEvent) pointer = { x: event.clientX, y: event.clientY }
  }
  const leave = () => { hovered = undefined; pointer = undefined }
  const stopEvent = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
  const pick = (event: Event) => {
    stopEvent(event)
    const element = targetOf(event)
    if (!element) return
    const rect = element.getBoundingClientRect()
    const path: string[] = []
    let ancestor: Element | null = element
    while (ancestor && path.length < 12) {
      path.unshift(shortLabel(ancestor))
      const parent: Element | null = ancestor.parentElement
      const tree: Node = ancestor.getRootNode()
      ancestor = parent ?? (tree instanceof ShadowRoot ? tree.host : null)
    }
    const clone = element.cloneNode(true) as Element
    clone.querySelectorAll('[data-helix-picker]').forEach((node) => node.remove())
    const fullHtml = clone.outerHTML
    const html = fullHtml.slice(0, maxCharacters)
    const styles = getComputedStyle(element)
    const fullCss = Array.from(styles).map((property) => `${property}: ${styles.getPropertyValue(property)};`).join('\n')
    const css = fullCss.slice(0, Math.max(0, maxCharacters - html.length))
    send({ type: 'selected', url: location.href, label: shortLabel(element), selector: path.join(' > '), html, css,
      dimensions: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      truncated: html.length < fullHtml.length || css.length < fullCss.length })
  }
  const key = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    stopEvent(event)
    cleanup()
    send({ type: 'cancelled' })
  }
  function cleanup(): void {
    live = false
    cancelAnimationFrame(animation)
    root.remove()
    document.removeEventListener('pointermove', move, true)
    document.removeEventListener('mouseleave', leave, true)
    for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) document.removeEventListener(name, stopEvent, true)
    document.removeEventListener('click', pick, true)
    document.removeEventListener('keydown', key, true)
    delete globals[cleanupName]
  }
  globals[cleanupName] = cleanup
  document.addEventListener('pointermove', move, true)
  document.addEventListener('mouseleave', leave, true)
  for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) document.addEventListener(name, stopEvent, true)
  document.addEventListener('click', pick, true)
  document.addEventListener('keydown', key, true)
  draw()
}

export function browserPickerExpression(bindingName: string, cleanupName: string, maxCharacters: number): string {
  return `(${installPicker.toString()})(${JSON.stringify(bindingName)}, ${JSON.stringify(cleanupName)}, ${maxCharacters})`
}
