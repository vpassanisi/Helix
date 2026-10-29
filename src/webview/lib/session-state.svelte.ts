import { LiveToolCallTracker } from '../../shared/live-tool-call-tracker.js'
import { StreamedStepTracker } from '../../shared/streamed-step-tracker.js'
import type { BrowserContextState } from '../../shared/browser-context.js'
import type { ExtensionInfo } from '../../shared/extension-info.js'
import type {
  ApprovalView,
  CodeChange,
  IncomingMessage,
  RuntimeState,
  SelectionMetadata,
  SidebarSettings,
} from '../types.js'

/**
 * The state of the session the Webview is showing: which session is active, the
 * runtime status, the composer draft, the turn flags, and the working maps the
 * stream handlers correlate on.
 */
export class SessionState {
  activeSessionId = $state('')
  runtimeState = $state<RuntimeState>('stopped')
  settings = $state<SidebarSettings | undefined>()
  extensionInfo = $state<ExtensionInfo | undefined>()
  selection = $state<SelectionMetadata | undefined>()
  selectionAttached = $state(true)
  browserContext = $state<BrowserContextState | undefined>()
  prompt = $state('')
  pendingSubmission = $state<{ text: string; userId: number } | undefined>()
  isGenerating = $state(false)
  waitingForFirstResponse = $state(false)
  codeChanges = $state<CodeChange[]>([])
  changesOpen = $state(false)

  hostChangesStarted = false
  toolCallsByStep: Record<string, string> = {}
  pendingApprovalRequests: Record<string, Extract<IncomingMessage, { type: 'approvalRequest' }> & { approval: ApprovalView }> = {}
  readonly streamedStepTracker = new StreamedStepTracker()
  readonly liveToolCallTracker = new LiveToolCallTracker()

  get skillPickerEnabled(): boolean {
    return this.settings?.skillPickerEnabled === true
  }

  get hasPendingSubmission(): boolean {
    return this.pendingSubmission !== undefined
  }

  beginTurn(): void {
    this.isGenerating = true
  }

  endTurn(): void {
    this.isGenerating = false
    this.waitingForFirstResponse = false
  }

  /** The host answered a submission: the draft is no longer pending. */
  dropPendingSubmission(): void {
    this.pendingSubmission = undefined
  }

  /** A new session: drop everything the previous one was carrying. */
  resetForSession(): void {
    this.toolCallsByStep = {}
    this.pendingApprovalRequests = {}
    this.codeChanges = []
    this.changesOpen = false
    this.hostChangesStarted = false
    this.endTurn()
  }
}
