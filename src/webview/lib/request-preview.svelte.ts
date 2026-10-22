import type { IncomingMessage, RequestPreviewResult, SidebarMessage } from '../types.js'

export type RequestPreviewStatus = 'idle' | 'loading' | 'success' | 'error' | 'cancelled'

/** Opening the previewer asks for this, so the page shows a request without typing. */
export const NOMINAL_PROMPT = 'Hello world!'

/** The Request Previewer page: the prompt being previewed and the reply it produced. */
export class RequestPreviewState {
  prompt = $state('')
  showRawJson = $state(false)
  status = $state<RequestPreviewStatus>('idle')
  result = $state<RequestPreviewResult | undefined>()
  error = $state('')

  constructor(private readonly post: (message: SidebarMessage) => void) {}

  /** Ask for the nominal prompt: the field fills in and the capture runs. */
  runNominal(): void {
    if (this.status === 'loading') return
    this.prompt = NOMINAL_PROMPT
    this.submit()
  }

  submit(): void {
    const text = this.prompt.trim()
    if (!text || this.status === 'loading') return
    this.status = 'loading'
    this.result = undefined
    this.error = ''
    this.post({ type: 'previewRequest', prompt: text })
  }

  cancel(): void {
    if (this.status !== 'loading') return
    this.post({ type: 'cancelRequestPreview' })
  }

  apply(message: Extract<IncomingMessage, { type: 'requestPreviewState' }>): void {
    this.status = message.state
    this.result = message.preview
    this.error = message.message ?? ''
  }
}
