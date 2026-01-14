/**
 * Server Settings Management
 *
 * Handles loading and persistence of server configuration.
 * Priority: environment variable > settings.json > default value
 *
 * When a value is loaded from environment variable and not present in settings.json,
 * it will be saved to settings.json for future use
 */

import { getSettingsFile, readSettings, writeSettings } from './settings'

export interface ServerSettings {
    telegramBotToken: string | null
    telegramNotification: boolean
    telegramNotificationVisibleWindowMs: number
    telegramNotificationRetryBaseDelayMs: number
    telegramNotificationRetryMaxAttempts: number
    pushNotificationVisibleWindowMs: number
    pushNotificationRetryBaseDelayMs: number
    pushNotificationRetryMaxAttempts: number
    sseHeartbeatMs: number
    webIdleTimeoutMs: number
    webappHost: string
    webappPort: number
    webappUrl: string
    corsOrigins: string[]
}

export interface ServerSettingsResult {
    settings: ServerSettings
    sources: {
        telegramBotToken: 'env' | 'file' | 'default'
        telegramNotification: 'env' | 'file' | 'default'
        telegramNotificationVisibleWindowMs: 'env' | 'file' | 'default'
        telegramNotificationRetryBaseDelayMs: 'env' | 'file' | 'default'
        telegramNotificationRetryMaxAttempts: 'env' | 'file' | 'default'
        pushNotificationVisibleWindowMs: 'env' | 'file' | 'default'
        pushNotificationRetryBaseDelayMs: 'env' | 'file' | 'default'
        pushNotificationRetryMaxAttempts: 'env' | 'file' | 'default'
        sseHeartbeatMs: 'env' | 'file' | 'default'
        webIdleTimeoutMs: 'env' | 'file' | 'default'
        webappHost: 'env' | 'file' | 'default'
        webappPort: 'env' | 'file' | 'default'
        webappUrl: 'env' | 'file' | 'default'
        corsOrigins: 'env' | 'file' | 'default'
    }
    savedToFile: boolean
}

/**
 * Parse and normalize CORS origins
 */
function parseCorsOrigins(str: string): string[] {
    const entries = str
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)

    if (entries.includes('*')) {
        return ['*']
    }

    const normalized: string[] = []
    for (const entry of entries) {
        try {
            normalized.push(new URL(entry).origin)
        } catch {
            // Keep raw value if it's already an origin-like string
            normalized.push(entry)
        }
    }
    return normalized
}

/**
 * Derive CORS origins from webapp URL
 */
function deriveCorsOrigins(webappUrl: string): string[] {
    try {
        return [new URL(webappUrl).origin]
    } catch {
        return []
    }
}

/**
 * Load server settings with priority: env > file > default
 * Saves new env values to file when not already present
 */
export async function loadServerSettings(dataDir: string): Promise<ServerSettingsResult> {
    const settingsFile = getSettingsFile(dataDir)
    const settings = await readSettings(settingsFile)

    // If settings file exists but couldn't be parsed, fail fast
    if (settings === null) {
        throw new Error(`Cannot read ${settingsFile}. Please fix or remove the file and restart.`)
    }

    let needsSave = false
    const sources: ServerSettingsResult['sources'] = {
        telegramBotToken: 'default',
        telegramNotification: 'default',
        telegramNotificationVisibleWindowMs: 'default',
        telegramNotificationRetryBaseDelayMs: 'default',
        telegramNotificationRetryMaxAttempts: 'default',
        pushNotificationVisibleWindowMs: 'default',
        pushNotificationRetryBaseDelayMs: 'default',
        pushNotificationRetryMaxAttempts: 'default',
        sseHeartbeatMs: 'default',
        webIdleTimeoutMs: 'default',
        webappHost: 'default',
        webappPort: 'default',
        webappUrl: 'default',
        corsOrigins: 'default',
    }
    // telegramBotToken: env > file > null
    let telegramBotToken: string | null = null
    if (process.env.TELEGRAM_BOT_TOKEN) {
        telegramBotToken = process.env.TELEGRAM_BOT_TOKEN
        sources.telegramBotToken = 'env'
        if (settings.telegramBotToken === undefined) {
            settings.telegramBotToken = telegramBotToken
            needsSave = true
        }
    } else if (settings.telegramBotToken !== undefined) {
        telegramBotToken = settings.telegramBotToken
        sources.telegramBotToken = 'file'
    }

    // telegramNotification: env > file > true (default enabled for backward compatibility)
    let telegramNotification = true
    if (process.env.TELEGRAM_NOTIFICATION !== undefined) {
        telegramNotification = process.env.TELEGRAM_NOTIFICATION === 'true'
        sources.telegramNotification = 'env'
        if (settings.telegramNotification === undefined) {
            settings.telegramNotification = telegramNotification
            needsSave = true
        }
    } else if (settings.telegramNotification !== undefined) {
        telegramNotification = settings.telegramNotification
        sources.telegramNotification = 'file'
    }

    // telegramNotificationVisibleWindowMs: env > file > 60000
    let telegramNotificationVisibleWindowMs = 60_000
    if (process.env.TELEGRAM_NOTIFICATION_VISIBLE_WINDOW_MS) {
        const parsed = parseInt(process.env.TELEGRAM_NOTIFICATION_VISIBLE_WINDOW_MS, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('TELEGRAM_NOTIFICATION_VISIBLE_WINDOW_MS must be a positive integer')
        }
        telegramNotificationVisibleWindowMs = parsed
        sources.telegramNotificationVisibleWindowMs = 'env'
        if (settings.telegramNotificationVisibleWindowMs === undefined) {
            settings.telegramNotificationVisibleWindowMs = telegramNotificationVisibleWindowMs
            needsSave = true
        }
    } else if (settings.telegramNotificationVisibleWindowMs !== undefined) {
        telegramNotificationVisibleWindowMs = settings.telegramNotificationVisibleWindowMs
        sources.telegramNotificationVisibleWindowMs = 'file'
    }

    // telegramNotificationRetryBaseDelayMs: env > file > 30000
    let telegramNotificationRetryBaseDelayMs = 30_000
    if (process.env.TELEGRAM_NOTIFICATION_RETRY_BASE_DELAY_MS) {
        const parsed = parseInt(process.env.TELEGRAM_NOTIFICATION_RETRY_BASE_DELAY_MS, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('TELEGRAM_NOTIFICATION_RETRY_BASE_DELAY_MS must be a positive integer')
        }
        telegramNotificationRetryBaseDelayMs = parsed
        sources.telegramNotificationRetryBaseDelayMs = 'env'
        if (settings.telegramNotificationRetryBaseDelayMs === undefined) {
            settings.telegramNotificationRetryBaseDelayMs = telegramNotificationRetryBaseDelayMs
            needsSave = true
        }
    } else if (settings.telegramNotificationRetryBaseDelayMs !== undefined) {
        telegramNotificationRetryBaseDelayMs = settings.telegramNotificationRetryBaseDelayMs
        sources.telegramNotificationRetryBaseDelayMs = 'file'
    }

    // telegramNotificationRetryMaxAttempts: env > file > 3
    let telegramNotificationRetryMaxAttempts = 3
    if (process.env.TELEGRAM_NOTIFICATION_RETRY_MAX_ATTEMPTS) {
        const parsed = parseInt(process.env.TELEGRAM_NOTIFICATION_RETRY_MAX_ATTEMPTS, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('TELEGRAM_NOTIFICATION_RETRY_MAX_ATTEMPTS must be a positive integer')
        }
        telegramNotificationRetryMaxAttempts = parsed
        sources.telegramNotificationRetryMaxAttempts = 'env'
        if (settings.telegramNotificationRetryMaxAttempts === undefined) {
            settings.telegramNotificationRetryMaxAttempts = telegramNotificationRetryMaxAttempts
            needsSave = true
        }
    } else if (settings.telegramNotificationRetryMaxAttempts !== undefined) {
        telegramNotificationRetryMaxAttempts = settings.telegramNotificationRetryMaxAttempts
        sources.telegramNotificationRetryMaxAttempts = 'file'
    }

    // pushNotificationVisibleWindowMs: env > file > 60000
    let pushNotificationVisibleWindowMs = 60_000
    if (process.env.PUSH_NOTIFICATION_VISIBLE_WINDOW_MS) {
        const parsed = parseInt(process.env.PUSH_NOTIFICATION_VISIBLE_WINDOW_MS, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('PUSH_NOTIFICATION_VISIBLE_WINDOW_MS must be a positive integer')
        }
        pushNotificationVisibleWindowMs = parsed
        sources.pushNotificationVisibleWindowMs = 'env'
        if (settings.pushNotificationVisibleWindowMs === undefined) {
            settings.pushNotificationVisibleWindowMs = pushNotificationVisibleWindowMs
            needsSave = true
        }
    } else if (settings.pushNotificationVisibleWindowMs !== undefined) {
        pushNotificationVisibleWindowMs = settings.pushNotificationVisibleWindowMs
        sources.pushNotificationVisibleWindowMs = 'file'
    }

    // pushNotificationRetryBaseDelayMs: env > file > 30000
    let pushNotificationRetryBaseDelayMs = 30_000
    if (process.env.PUSH_NOTIFICATION_RETRY_BASE_DELAY_MS) {
        const parsed = parseInt(process.env.PUSH_NOTIFICATION_RETRY_BASE_DELAY_MS, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('PUSH_NOTIFICATION_RETRY_BASE_DELAY_MS must be a positive integer')
        }
        pushNotificationRetryBaseDelayMs = parsed
        sources.pushNotificationRetryBaseDelayMs = 'env'
        if (settings.pushNotificationRetryBaseDelayMs === undefined) {
            settings.pushNotificationRetryBaseDelayMs = pushNotificationRetryBaseDelayMs
            needsSave = true
        }
    } else if (settings.pushNotificationRetryBaseDelayMs !== undefined) {
        pushNotificationRetryBaseDelayMs = settings.pushNotificationRetryBaseDelayMs
        sources.pushNotificationRetryBaseDelayMs = 'file'
    }

    // pushNotificationRetryMaxAttempts: env > file > 3
    let pushNotificationRetryMaxAttempts = 3
    if (process.env.PUSH_NOTIFICATION_RETRY_MAX_ATTEMPTS) {
        const parsed = parseInt(process.env.PUSH_NOTIFICATION_RETRY_MAX_ATTEMPTS, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('PUSH_NOTIFICATION_RETRY_MAX_ATTEMPTS must be a positive integer')
        }
        pushNotificationRetryMaxAttempts = parsed
        sources.pushNotificationRetryMaxAttempts = 'env'
        if (settings.pushNotificationRetryMaxAttempts === undefined) {
            settings.pushNotificationRetryMaxAttempts = pushNotificationRetryMaxAttempts
            needsSave = true
        }
    } else if (settings.pushNotificationRetryMaxAttempts !== undefined) {
        pushNotificationRetryMaxAttempts = settings.pushNotificationRetryMaxAttempts
        sources.pushNotificationRetryMaxAttempts = 'file'
    }

    // sseHeartbeatMs: env > file > 30000
    let sseHeartbeatMs = 30_000
    if (process.env.SSE_HEARTBEAT_MS) {
        const parsed = parseInt(process.env.SSE_HEARTBEAT_MS, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('SSE_HEARTBEAT_MS must be a positive integer')
        }
        sseHeartbeatMs = parsed
        sources.sseHeartbeatMs = 'env'
        if (settings.sseHeartbeatMs === undefined) {
            settings.sseHeartbeatMs = sseHeartbeatMs
            needsSave = true
        }
    } else if (settings.sseHeartbeatMs !== undefined) {
        sseHeartbeatMs = settings.sseHeartbeatMs
        sources.sseHeartbeatMs = 'file'
    }

    // webIdleTimeoutMs: env > file > 120000
    let webIdleTimeoutMs = 120_000
    if (process.env.WEB_IDLE_TIMEOUT_MS) {
        const parsed = parseInt(process.env.WEB_IDLE_TIMEOUT_MS, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('WEB_IDLE_TIMEOUT_MS must be a positive integer')
        }
        webIdleTimeoutMs = parsed
        sources.webIdleTimeoutMs = 'env'
        if (settings.webIdleTimeoutMs === undefined) {
            settings.webIdleTimeoutMs = webIdleTimeoutMs
            needsSave = true
        }
    } else if (settings.webIdleTimeoutMs !== undefined) {
        webIdleTimeoutMs = settings.webIdleTimeoutMs
        sources.webIdleTimeoutMs = 'file'
    }

    // webappHost: env > file > 127.0.0.1
    let webappHost = '127.0.0.1'
    if (process.env.WEBAPP_HOST) {
        webappHost = process.env.WEBAPP_HOST
        sources.webappHost = 'env'
        if (settings.webappHost === undefined) {
            settings.webappHost = webappHost
            needsSave = true
        }
    } else if (settings.webappHost !== undefined) {
        webappHost = settings.webappHost
        sources.webappHost = 'file'
    }

    // webappPort: env > file > 3006
    let webappPort = 3006
    if (process.env.WEBAPP_PORT) {
        const parsed = parseInt(process.env.WEBAPP_PORT, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
            throw new Error('WEBAPP_PORT must be a valid port number')
        }
        webappPort = parsed
        sources.webappPort = 'env'
        if (settings.webappPort === undefined) {
            settings.webappPort = webappPort
            needsSave = true
        }
    } else if (settings.webappPort !== undefined) {
        webappPort = settings.webappPort
        sources.webappPort = 'file'
    }

    // webappUrl: env > file > http://localhost:{port}
    let webappUrl = `http://localhost:${webappPort}`
    if (process.env.WEBAPP_URL) {
        webappUrl = process.env.WEBAPP_URL
        sources.webappUrl = 'env'
        if (settings.webappUrl === undefined) {
            settings.webappUrl = webappUrl
            needsSave = true
        }
    } else if (settings.webappUrl !== undefined) {
        webappUrl = settings.webappUrl
        sources.webappUrl = 'file'
    }

    // corsOrigins: env > file > derived from webappUrl
    let corsOrigins: string[]
    if (process.env.CORS_ORIGINS) {
        corsOrigins = parseCorsOrigins(process.env.CORS_ORIGINS)
        sources.corsOrigins = 'env'
        if (settings.corsOrigins === undefined) {
            settings.corsOrigins = corsOrigins
            needsSave = true
        }
    } else if (settings.corsOrigins !== undefined) {
        corsOrigins = settings.corsOrigins
        sources.corsOrigins = 'file'
    } else {
        corsOrigins = deriveCorsOrigins(webappUrl)
    }

    // Save settings if any new values were added
    if (needsSave) {
        await writeSettings(settingsFile, settings)
    }

    return {
        settings: {
            telegramBotToken,
            telegramNotification,
            telegramNotificationVisibleWindowMs,
            telegramNotificationRetryBaseDelayMs,
            telegramNotificationRetryMaxAttempts,
            pushNotificationVisibleWindowMs,
            pushNotificationRetryBaseDelayMs,
            pushNotificationRetryMaxAttempts,
            sseHeartbeatMs,
            webIdleTimeoutMs,
            webappHost,
            webappPort,
            webappUrl,
            corsOrigins,
        },
        sources,
        savedToFile: needsSave,
    }
}
