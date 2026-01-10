import {
    bindThemeParamsCssVars,
    bindViewportCssVars,
    init,
    miniApp,
    viewportContentSafeAreaInsets,
    viewportSafeAreaInsets,
} from '@telegram-apps/sdk'
import { getTelegramWebApp, isTelegramEnvironment } from '@/hooks/useTelegram'

type SafeAreaInsets = {
    top: number
    bottom: number
    left: number
    right: number
}

function setInsetVars(prefix: string, insets: SafeAreaInsets): void {
    const root = document.documentElement
    root.style.setProperty(`${prefix}-top`, `${insets.top}px`)
    root.style.setProperty(`${prefix}-bottom`, `${insets.bottom}px`)
    root.style.setProperty(`${prefix}-left`, `${insets.left}px`)
    root.style.setProperty(`${prefix}-right`, `${insets.right}px`)
}

function readInsets<T>(reader: () => T): T | null {
    try {
        return reader()
    } catch {
        return null
    }
}

function toSafeAreaInsets(value: unknown): SafeAreaInsets | null {
    if (!value || typeof value !== 'object') {
        return null
    }

    const insets = value as SafeAreaInsets
    if (
        typeof insets.top !== 'number' ||
        typeof insets.bottom !== 'number' ||
        typeof insets.left !== 'number' ||
        typeof insets.right !== 'number'
    ) {
        return null
    }

    return insets
}

function updateSafeAreaVars(): void {
    const safeInsets = toSafeAreaInsets(readInsets(viewportSafeAreaInsets))
    if (safeInsets) {
        setInsetVars('--app-safe-area', safeInsets)
    }

    const contentInsets = toSafeAreaInsets(readInsets(viewportContentSafeAreaInsets))
    if (contentInsets) {
        setInsetVars('--app-content-safe-area', contentInsets)
    }
}

export function initializeTelegramSdk(): void {
    if (!isTelegramEnvironment()) {
        return
    }

    try {
        init()
    } catch {
        return
    }

    if (bindViewportCssVars.isAvailable()) {
        bindViewportCssVars()
    }

    if (bindThemeParamsCssVars.isAvailable()) {
        bindThemeParamsCssVars()
    }

    if (miniApp.bindCssVars.isAvailable()) {
        miniApp.bindCssVars()
    }

    updateSafeAreaVars()

    const tg = getTelegramWebApp()
    if (tg?.onEvent) {
        tg.onEvent('viewportChanged', updateSafeAreaVars)
        tg.onEvent('safeAreaChanged', updateSafeAreaVars)
    }
}
