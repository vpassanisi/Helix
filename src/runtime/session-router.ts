import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type {
  DisposableLike,
  RoutedNotification,
  SessionRouteMode,
} from './types.js'

interface SessionRoute {
  mode: SessionRouteMode
  handler: (notification: RoutedNotification) => void
}

export interface SessionNotificationRouterOptions {
  onUnrouted?: (notification: HarnessNotification) => void
  onHandlerError?: (error: unknown, notification: HarnessNotification) => void
}

export class SessionNotificationRouter {
  private readonly routes = new Map<string, SessionRoute>()
  private readonly parents = new Map<string, string>()

  constructor(private readonly options: SessionNotificationRouterOptions = {}) {}

  register(
    rootSessionId: string,
    handler: (notification: RoutedNotification) => void,
    mode: SessionRouteMode = 'tree',
  ): DisposableLike {
    this.routes.set(rootSessionId, { mode, handler })

    return {
      dispose: () => {
        const current = this.routes.get(rootSessionId)
        if (current?.handler === handler) this.routes.delete(rootSessionId)
      },
    }
  }

  accept(notification: HarnessNotification): void {
    const params = notification.params ?? {}

    if (notification.method === 'subagent.started') {
      this.recordParent(params)
    }

    const relatedIds = this.relatedSessionIds(notification)
    const primarySessionId = this.primarySessionId(notification)

    if (relatedIds.length === 0 || primarySessionId === undefined) {
      this.options.onUnrouted?.(notification)
      return
    }

    let delivered = false

    for (const [rootSessionId, route] of this.routes) {
      const matches = route.mode === 'exact'
        ? this.matchesExact(notification, rootSessionId, relatedIds)
        : relatedIds.some((sessionId) => this.isDescendantOf(sessionId, rootSessionId))

      if (!matches) continue

      delivered = true
      try {
        route.handler({
          rootSessionId,
          sessionId: primarySessionId,
          notification,
        })
      } catch (error) {
        this.options.onHandlerError?.(error, notification)
      }
    }

    if (!delivered) this.options.onUnrouted?.(notification)

    if (notification.method === 'subagent.finished') {
      const childSessionId = this.stringValue(params.childSessionId)
      if (childSessionId !== undefined) this.parents.delete(childSessionId)
    }
  }

  resetLineage(): void {
    this.parents.clear()
  }

  clear(): void {
    this.routes.clear()
    this.parents.clear()
  }

  private matchesExact(
    notification: HarnessNotification,
    rootSessionId: string,
    relatedIds: string[],
  ): boolean {
    if (notification.method === 'session.event' || notification.method === 'session.status') {
      return relatedIds[0] === rootSessionId
    }

    return relatedIds.includes(rootSessionId)
  }

  private relatedSessionIds(notification: HarnessNotification): string[] {
    const params = notification.params ?? {}

    if (notification.method === 'session.event' || notification.method === 'session.status') {
      const sessionId = this.stringValue(params.sessionId)
      return sessionId === undefined ? [] : [sessionId]
    }

    if (notification.method === 'subagent.started' || notification.method === 'subagent.finished') {
      return [params.parentSessionId, params.childSessionId]
        .map((value) => this.stringValue(value))
        .filter((value): value is string => value !== undefined)
    }

    return []
  }

  private primarySessionId(notification: HarnessNotification): string | undefined {
    const params = notification.params ?? {}

    if (notification.method === 'session.event' || notification.method === 'session.status') {
      return this.stringValue(params.sessionId)
    }

    return this.stringValue(params.childSessionId) ?? this.stringValue(params.parentSessionId)
  }

  private recordParent(params: Record<string, unknown>): void {
    const parentSessionId = this.stringValue(params.parentSessionId)
    const childSessionId = this.stringValue(params.childSessionId)

    if (
      parentSessionId !== undefined &&
      childSessionId !== undefined &&
      parentSessionId !== childSessionId
    ) {
      this.parents.set(childSessionId, parentSessionId)
    }
  }

  private isDescendantOf(sessionId: string, rootSessionId: string): boolean {
    const visited = new Set<string>()
    let current = sessionId

    while (!visited.has(current)) {
      if (current === rootSessionId) return true
      visited.add(current)
      const parent = this.parents.get(current)
      if (parent === undefined) return false
      current = parent
    }

    return false
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
}
