import type { Session } from '../sync/syncEngine'
import type { NotificationChannel } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { PushPayload, PushService } from './pushService'

type PushNotificationChannelOptions = {
    disableWebPush?: boolean
    recentVisibleWindowMs?: number
    retryBaseDelayMs?: number
    retryMaxAttempts?: number
}

export class PushNotificationChannel implements NotificationChannel {
    private readonly disableWebPush: boolean
    private readonly activityWindowMs: number
    private readonly retryBaseDelayMs: number
    private readonly retryMaxAttempts: number
    private readonly retryStates = new Map<string, { timer: NodeJS.Timeout | null; attempt: number }>()

    constructor(
        private readonly pushService: PushService,
        private readonly sseManager: SSEManager,
        private readonly visibilityTracker: VisibilityTracker,
        _appUrl: string,
        options?: PushNotificationChannelOptions
    ) {
        this.disableWebPush = options?.disableWebPush ?? false
        this.activityWindowMs = options?.recentVisibleWindowMs ?? 60_000
        this.retryBaseDelayMs = options?.retryBaseDelayMs ?? 30_000
        this.retryMaxAttempts = options?.retryMaxAttempts ?? 3
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)
        const request = session.agentState?.requests
            ? Object.values(session.agentState.requests)[0]
            : null
        const toolName = request?.tool ? ` (${request.tool})` : ''

        const payload: PushPayload = {
            title: 'Permission Request',
            body: `${name}${toolName}`,
            tag: `permission-${session.id}`,
            data: {
                type: 'permission-request',
                sessionId: session.id,
                url: this.buildSessionPath(session.id)
            }
        }

        const url = payload.data?.url ?? this.buildSessionPath(session.id)
        if (this.visibilityTracker.hasVisibleConnection(session.namespace)) {
            const delivered = await this.sseManager.sendToast(session.namespace, {
                type: 'toast',
                data: {
                    title: payload.title,
                    body: payload.body,
                    sessionId: session.id,
                    url
                }
            })
            if (delivered > 0) {
                return
            }
        }

        if (this.sseManager.hasPcConnection(session.namespace)) {
            console.log(`[Push] Suppressed: pc-online namespace=${session.namespace} session=${session.id}`)
            return
        }

        if (this.visibilityTracker.hasRecentVisibleConnection(session.namespace, this.activityWindowMs)) {
            return
        }

        if (this.disableWebPush) {
            return
        }

        await this.sendWithRetry('permission', session, payload)
    }

    async sendReady(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)

        const payload: PushPayload = {
            title: 'Ready for input',
            body: `${agentName} is waiting in ${name}`,
            tag: `ready-${session.id}`,
            data: {
                type: 'ready',
                sessionId: session.id,
                url: this.buildSessionPath(session.id)
            }
        }

        const url = payload.data?.url ?? this.buildSessionPath(session.id)
        if (this.visibilityTracker.hasVisibleConnection(session.namespace)) {
            const delivered = await this.sseManager.sendToast(session.namespace, {
                type: 'toast',
                data: {
                    title: payload.title,
                    body: payload.body,
                    sessionId: session.id,
                    url
                }
            })
            if (delivered > 0) {
                return
            }
        }

        if (this.sseManager.hasPcConnection(session.namespace)) {
            console.log(`[Push] Suppressed: pc-online namespace=${session.namespace} session=${session.id}`)
            return
        }

        if (this.visibilityTracker.hasRecentVisibleConnection(session.namespace, this.activityWindowMs)) {
            return
        }

        if (this.disableWebPush) {
            return
        }

        await this.sendWithRetry('ready', session, payload)
    }

    private buildSessionPath(sessionId: string): string {
        return `/sessions/${sessionId}`
    }

    private async sendWithRetry(type: 'permission' | 'ready', session: Session, payload: PushPayload): Promise<void> {
        const key = `${type}:${session.id}`
        this.clearRetry(key)

        await this.pushService.sendToNamespace(session.namespace, this.withAttempt(payload, 1))

        this.retryStates.set(key, { timer: null, attempt: 1 })
        this.scheduleRetry(key, type, session, payload)
    }

    private scheduleRetry(
        key: string,
        type: 'permission' | 'ready',
        session: Session,
        payload: PushPayload
    ): void {
        const state = this.retryStates.get(key)
        if (!state) {
            return
        }

        if (state.attempt >= this.retryMaxAttempts) {
            this.clearRetry(key)
            return
        }

        const delay = this.retryBaseDelayMs * Math.pow(2, state.attempt - 1)
        state.timer = setTimeout(async () => {
            if (this.sseManager.hasPcConnection(session.namespace)) {
                console.log(`[Push] Retry stopped: pc-online namespace=${session.namespace} session=${session.id}`)
                this.clearRetry(key)
                return
            }

            if (this.visibilityTracker.hasRecentVisibleConnection(session.namespace, this.activityWindowMs)) {
                this.clearRetry(key)
                return
            }

            if (this.disableWebPush) {
                this.clearRetry(key)
                return
            }

            const nextAttempt = state.attempt + 1
            try {
                await this.pushService.sendToNamespace(session.namespace, this.withAttempt(payload, nextAttempt))
            } catch {
                // Ignore send errors; we'll rely on push service cleanup.
            }

            const next = this.retryStates.get(key)
            if (!next) {
                return
            }

            next.attempt = nextAttempt
            this.scheduleRetry(key, type, session, payload)
        }, delay)
    }

    private clearRetry(key: string): void {
        const existing = this.retryStates.get(key)
        if (!existing) {
            return
        }
        if (existing.timer) {
            clearTimeout(existing.timer)
        }
        this.retryStates.delete(key)
    }

    private withAttempt(payload: PushPayload, attempt: number): PushPayload {
        if (!payload.body) {
            return payload
        }
        return {
            ...payload,
            body: `${payload.body} (${attempt}/${this.retryMaxAttempts})`
        }
    }
}
