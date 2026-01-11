/**
 * Telegram Bot for HAPI
 *
 * Simplified bot that only handles notifications (permission requests and ready events).
 * All interactive features are handled by the Telegram Mini App.
 */

import { Bot, Context, InlineKeyboard } from 'grammy'
import { SyncEngine, Session } from '../sync/syncEngine'
import { handleCallback, CallbackContext } from './callbacks'
import { formatSessionNotification, createNotificationKeyboard } from './sessionView'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { NotificationChannel } from '../notifications/notificationTypes'
import type { Store } from '../store'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { TerminalRegistry } from '../socket/terminalRegistry'

export interface BotContext extends Context {
    // Extended context for future use
}

export interface HappyBotConfig {
    syncEngine: SyncEngine
    botToken: string
    miniAppUrl: string
    store: Store
    terminalRegistry?: TerminalRegistry
    sseManager?: SSEManager
    visibilityTracker?: VisibilityTracker
    recentVisibleWindowMs?: number
    retryBaseDelayMs?: number
    retryMaxAttempts?: number
}

/**
 * HAPI Telegram Bot - Notification-only mode
 */
export class HappyBot implements NotificationChannel {
    private bot: Bot<BotContext>
    private syncEngine: SyncEngine | null = null
    private isRunning = false
    private readonly miniAppUrl: string
    private readonly store: Store
    private readonly terminalRegistry?: TerminalRegistry
    private readonly sseManager?: SSEManager
    private readonly visibilityTracker?: VisibilityTracker
    private readonly recentVisibleWindowMs: number
    private readonly retryBaseDelayMs: number
    private readonly retryMaxAttempts: number
    private readonly retryStates = new Map<string, { timer: NodeJS.Timeout | null; attempt: number }>()

    constructor(config: HappyBotConfig) {
        this.syncEngine = config.syncEngine
        this.miniAppUrl = config.miniAppUrl
        this.store = config.store
        this.terminalRegistry = config.terminalRegistry
        this.sseManager = config.sseManager
        this.visibilityTracker = config.visibilityTracker
        this.recentVisibleWindowMs = config.recentVisibleWindowMs ?? 60_000
        this.retryBaseDelayMs = config.retryBaseDelayMs ?? 30_000
        this.retryMaxAttempts = config.retryMaxAttempts ?? 3

        this.bot = new Bot<BotContext>(config.botToken)
        this.setupMiddleware()
        this.setupCommands()
        this.setupCallbacks()

        if (this.syncEngine) {
            this.setSyncEngine(this.syncEngine)
        }
    }

    /**
     * Update the sync engine reference (after auth)
     */
    setSyncEngine(engine: SyncEngine): void {
        this.syncEngine = engine
    }

    /**
     * Get the underlying bot instance
     */
    getBot(): Bot<BotContext> {
        return this.bot
    }

    /**
     * Start the bot
     */
    async start(): Promise<void> {
        if (this.isRunning) return

        console.log('[HAPIBot] Starting Telegram bot...')
        this.isRunning = true

        // Start polling
        this.bot.start({
            onStart: (botInfo) => {
                console.log(`[HAPIBot] Bot @${botInfo.username} started`)
            }
        })
    }

    /**
     * Stop the bot
     */
    async stop(): Promise<void> {
        if (!this.isRunning) return

        console.log('[HAPIBot] Stopping Telegram bot...')

        await this.bot.stop()
        this.isRunning = false
    }

    /**
     * Setup middleware
     */
    private setupMiddleware(): void {
        // Error handling middleware
        this.bot.catch((err) => {
            console.error('[HAPIBot] Error:', err.message)
        })
    }

    /**
     * Setup command handlers
     */
    private setupCommands(): void {
        // /app - Open Telegram Mini App (primary entry point)
        this.bot.command('app', async (ctx) => {
            const keyboard = new InlineKeyboard().webApp('Open App', this.miniAppUrl)
            await ctx.reply('Open HAPI Mini App:', { reply_markup: keyboard })
        })

        // /start - Simple welcome with Mini App link
        this.bot.command('start', async (ctx) => {
            const keyboard = new InlineKeyboard().webApp('Open App', this.miniAppUrl)
            await ctx.reply(
                'Welcome to HAPI Bot!\n\n' +
                'Use the Mini App for full session management.',
                { reply_markup: keyboard }
            )
        })
    }

    /**
     * Setup callback query handlers for notification buttons
     */
    private setupCallbacks(): void {
        this.bot.on('callback_query:data', async (ctx) => {
            if (!this.syncEngine) {
                await ctx.answerCallbackQuery('Not connected')
                return
            }

            const namespace = this.getNamespaceForChatId(ctx.from?.id ?? null)
            if (!namespace) {
                await ctx.answerCallbackQuery('Telegram account is not bound')
                return
            }

            const data = ctx.callbackQuery.data

            const callbackContext: CallbackContext = {
                syncEngine: this.syncEngine,
                namespace,
                answerCallback: async (text?: string) => {
                    await ctx.answerCallbackQuery(text)
                },
                editMessage: async (text, keyboard) => {
                    await ctx.editMessageText(text, {
                        reply_markup: keyboard
                    })
                }
            }

            await handleCallback(data, callbackContext)
        })
    }

    /**
     * Get bound Telegram chat IDs from storage.
     */
    private getBoundChatIds(namespace: string): number[] {
        const users = this.store.users.getUsersByPlatformAndNamespace('telegram', namespace)
        const ids = new Set<number>()
        for (const user of users) {
            const chatId = Number(user.platformUserId)
            if (Number.isFinite(chatId)) {
                ids.add(chatId)
            }
        }
        return Array.from(ids)
    }

    private getNamespaceForChatId(chatId: number | null | undefined): string | null {
        if (!chatId) {
            return null
        }
        const stored = this.store.users.getUser('telegram', String(chatId))
        return stored?.namespace ?? null
    }

    /**
     * Send a notification when agent is ready for input.
     */
    async sendReady(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        if (this.sseManager?.hasPcConnection(session.namespace)) {
            console.log(`[Telegram] Suppressed: pc-online namespace=${session.namespace} session=${session.id}`)
            return
        }

        if (this.hasRecentVisibleActivity(session.namespace)) {
            return
        }

        if (this.terminalRegistry && this.terminalRegistry.countForSession(session.id) > 0) {
            return
        }

        const agentName = getAgentName(session)
        const sessionName = getSessionName(session)
        const directory = session.metadata?.path ?? null
        const url = buildSessionLink(this.miniAppUrl, session.id)
        const lines = [
            'Session ready.',
            '',
            `Agent: ${agentName}`,
            `Title: ${sessionName}`,
            directory ? `Directory: ${directory}` : null,
            '',
            `Open: ${url}`
        ].filter((line): line is string => Boolean(line))
        const message = lines.join('\n')

        const chatIds = this.getBoundChatIds(session.namespace)
        if (chatIds.length === 0) {
            return
        }

        await this.sendWithRetry('ready', session, chatIds, message)
    }

    /**
     * Send permission notification to all bound chats
     */
    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        if (this.sseManager?.hasPcConnection(session.namespace)) {
            console.log(`[Telegram] Suppressed: pc-online namespace=${session.namespace} session=${session.id}`)
            return
        }

        if (this.hasRecentVisibleActivity(session.namespace)) {
            return
        }

        const text = formatSessionNotification(session)
        const keyboard = createNotificationKeyboard(session, this.miniAppUrl)

        const chatIds = this.getBoundChatIds(session.namespace)
        if (chatIds.length === 0) {
            return
        }

        await this.sendWithRetry('permission', session, chatIds, text, keyboard)
    }

    private hasRecentVisibleActivity(namespace: string): boolean {
        if (!this.visibilityTracker) {
            return false
        }
        return this.visibilityTracker.hasRecentVisibleConnection(namespace, this.recentVisibleWindowMs)
    }

    private async sendWithRetry(
        type: 'permission' | 'ready',
        session: Session,
        chatIds: number[],
        text: string,
        keyboard?: InlineKeyboard
    ): Promise<void> {
        const key = `${type}:${session.id}`
        this.clearRetry(key)

        console.log(`[Telegram] Send: type=${type} namespace=${session.namespace} session=${session.id} attempt=initial`)
        await this.sendToChats(chatIds, text, keyboard)

        this.retryStates.set(key, { timer: null, attempt: 0 })
        this.scheduleRetry(key, type, session, chatIds, text, keyboard)
    }

    private scheduleRetry(
        key: string,
        type: 'permission' | 'ready',
        session: Session,
        chatIds: number[],
        text: string,
        keyboard?: InlineKeyboard
    ): void {
        const state = this.retryStates.get(key)
        if (!state) {
            return
        }

        if (state.attempt >= this.retryMaxAttempts) {
            this.clearRetry(key)
            return
        }

        const delay = this.retryBaseDelayMs * Math.pow(2, state.attempt)
        state.timer = setTimeout(async () => {
            if (this.sseManager?.hasPcConnection(session.namespace)) {
                console.log(`[Telegram] Retry stopped: pc-online namespace=${session.namespace} session=${session.id}`)
                this.clearRetry(key)
                return
            }

            if (this.hasRecentVisibleActivity(session.namespace)) {
                this.clearRetry(key)
                return
            }

            const nextAttempt = state.attempt + 1
            console.log(
                `[Telegram] Send: type=${type} namespace=${session.namespace} session=${session.id} attempt=${nextAttempt}/${this.retryMaxAttempts}`
            )
            await this.sendToChats(chatIds, this.withAttempt(text, nextAttempt), keyboard)

            const next = this.retryStates.get(key)
            if (!next) {
                return
            }

            next.attempt = nextAttempt
            this.scheduleRetry(key, type, session, chatIds, text, keyboard)
        }, delay)
    }

    private async sendToChats(chatIds: number[], text: string, keyboard?: InlineKeyboard): Promise<void> {
        for (const chatId of chatIds) {
            try {
                await this.bot.api.sendMessage(chatId, text, keyboard ? { reply_markup: keyboard } : undefined)
            } catch (error) {
                console.error(`[HAPIBot] Failed to send notification to chat ${chatId}:`, error)
            }
        }
    }

    private withAttempt(text: string, attempt: number): string {
        return `${text}\n\nAttempt: ${attempt}/${this.retryMaxAttempts}`
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
}

function buildSessionLink(baseUrl: string, sessionId: string): string {
    try {
        const url = new URL(baseUrl)
        return `${url.origin}/sessions/${sessionId}`
    } catch {
        const trimmed = baseUrl.replace(/\/+$/, '')
        return `${trimmed}/sessions/${sessionId}`
    }
}
