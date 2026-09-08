import DOMPurify from 'dompurify'
import { marked } from 'marked'

export function renderMarkdown(source: string): string {
  const parsed = marked.parse(source, {
    gfm: true,
    breaks: false,
  })

  return DOMPurify.sanitize(typeof parsed === 'string' ? parsed : '', {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['embed', 'form', 'iframe', 'img', 'input', 'math', 'object', 'style', 'svg'],
  })
}
