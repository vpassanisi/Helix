export interface BrowserElementContext {
  id: string
  url: string
  label: string
  selector: string
  html: string
  css: string
  dimensions: { top: number; left: number; width: number; height: number }
  truncated: boolean
}

export interface BrowserContextState {
  sessionId: string
  available: boolean
  hasOpenBrowser: boolean
  picking: boolean
  attachments: BrowserElementContext[]
  message?: string
}

/** Apply one budget to all browser reference text, preserving selection order. */
export function limitBrowserContext(elements: readonly BrowserElementContext[], maxCharacters: number): BrowserElementContext[] {
  let remaining = Math.max(0, maxCharacters)
  return elements.map((element) => {
    const html = element.html.slice(0, remaining)
    remaining -= html.length
    const css = element.css.slice(0, remaining)
    remaining -= css.length
    return { ...element, html, css, truncated: element.truncated || html.length < element.html.length || css.length < element.css.length }
  })
}
