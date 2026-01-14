import { ComposerPrimitive } from '@assistant-ui/react'
import { useEffect, useId, useRef, useState } from 'react'
import { FileDiffIcon, TerminalIcon } from '@/components/ToolCard/icons'
import { useTranslation } from '@/lib/use-translation'

function SwitchToRemoteIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <line x1="12" y1="18" x2="12.01" y2="18" />
        </svg>
    )
}

function TerminalIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="3" y="4" width="18" height="16" rx="2" ry="2" />
            <polyline points="7 9 10 12 7 15" />
            <line x1="12" y1="15" x2="17" y2="15" />
        </svg>
    )
}

function AttachmentIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78" />
        </svg>
    )
}

function AbortIcon(props: { spinning: boolean }) {
    if (props.spinning) {
        return (
            <svg
                className="animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
            >
                <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="0.75" />
            </svg>
        )
    }

    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4-2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-4a.5.5 0 0 1-.5-.5v-4Z" />
        </svg>
    )
}

function SendIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
        </svg>
    )
}

function MenuIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={props.className}
        >
            <circle cx="12" cy="5" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="12" cy="19" r="2" />
        </svg>
    )
}

export function ComposerButtons(props: {
    canSend: boolean
    threadIsRunning: boolean
    controlsDisabled: boolean
    showRenameButton: boolean
    renameDisabled: boolean
    onRename: () => void
    showArchiveButton: boolean
    archiveDisabled: boolean
    onArchive: () => void
    showDeleteButton: boolean
    deleteDisabled: boolean
    onDelete: () => void
    showCloseAndNewButton: boolean
    closeAndNewDisabled: boolean
    onCloseAndNew: () => void
    showTerminalButton: boolean
    terminalDisabled: boolean
    terminalConfirmActive: boolean
    onTerminal: () => void
    showFilesButton: boolean
    filesDisabled: boolean
    filesConfirmActive: boolean
    onFiles: () => void
    abortDisabled: boolean
    isAborting: boolean
    abortConfirmActive: boolean
    onAbort: () => void
    showSwitchButton: boolean
    switchDisabled: boolean
    isSwitching: boolean
    onSwitch: () => void
}) {
    const { t } = useTranslation()
    const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
    const sessionMenuRef = useRef<HTMLDivElement | null>(null)
    const sessionMenuId = useId()

    const showSessionMenu =
        props.showRenameButton || props.showArchiveButton || props.showDeleteButton || props.showCloseAndNewButton
    const leftButtonCount =
        (showSessionMenu ? 1 : 0) +
        (props.showTerminalButton ? 1 : 0) +
        (props.showFilesButton ? 1 : 0) +
        (props.showSwitchButton ? 1 : 0)

    useEffect(() => {
        if (!sessionMenuOpen) return

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node | null
            if (!target) return
            if (sessionMenuRef.current?.contains(target)) return
            setSessionMenuOpen(false)
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setSessionMenuOpen(false)
            }
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [sessionMenuOpen])

    const baseItemClassName =
        'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'

    const getItemClassName = (disabled: boolean, danger = false) => {
        if (disabled) {
            return `${baseItemClassName} cursor-not-allowed opacity-50`
        }
        if (danger) {
            return `${baseItemClassName} text-red-500 hover:bg-red-500/10`
        }
        return `${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`
    }

    return (
        <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
                <ComposerPrimitive.AddAttachment
                    aria-label={t('composer.attach')}
                    title={t('composer.attach')}
                    disabled={props.controlsDisabled}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <AttachmentIcon />
                </ComposerPrimitive.AddAttachment>

                                {props.showCloseAndNewButton ? (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className={getItemClassName(props.closeAndNewDisabled, true)}
                                        onClick={() => {
                                            setSessionMenuOpen(false)
                                            props.onCloseAndNew()
                                        }}
                                        disabled={props.closeAndNewDisabled}
                                    >
                                        {t('session.action.closeAndNew')}
                                    </button>
                                ) : null}

                                {props.showDeleteButton ? (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className={getItemClassName(props.deleteDisabled, true)}
                                        onClick={() => {
                                            setSessionMenuOpen(false)
                                            props.onDelete()
                                        }}
                                        disabled={props.deleteDisabled}
                                    >
                                        {t('session.action.delete')}
                                    </button>
                                ) : null}
                            </div>
                        ) : null}
                    </div>
                ) : null}

                <div className="flex items-center gap-2">
                    {props.showTerminalButton ? (
                        <button
                            type="button"
                            aria-label={
                                props.terminalConfirmActive ? t('composer.terminalConfirm') : t('composer.terminal')
                            }
                            title={props.terminalConfirmActive ? t('composer.terminalConfirm') : t('composer.terminal')}
                            disabled={props.terminalDisabled}
                            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--app-fg)]/65 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={props.onTerminal}
                        >
                            <TerminalIcon className="h-4 w-4" />
                        </button>
                    ) : null}

                    {props.showFilesButton ? (
                        <button
                            type="button"
                            aria-label={props.filesConfirmActive ? t('composer.filesConfirm') : t('session.title')}
                            title={props.filesConfirmActive ? t('composer.filesConfirm') : t('session.title')}
                            disabled={props.filesDisabled}
                            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--app-fg)]/65 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={props.onFiles}
                        >
                            <FileDiffIcon className="h-4 w-4" />
                        </button>
                    ) : null}

                    {props.showSwitchButton ? (
                        <button
                            type="button"
                            aria-label={t('composer.switchRemote')}
                            title={t('composer.switchRemote')}
                            disabled={props.switchDisabled}
                            className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--app-fg)]/65 transition-colors hover:bg-[var(--app-bg)] hover:text-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={props.onSwitch}
                        >
                            <SwitchToRemoteIcon />
                        </button>
                    ) : null}
                </div>
            </div>

            <ComposerPrimitive.Send
                disabled={props.controlsDisabled || !props.canSend}
                aria-label={t('composer.send')}
                title={t('composer.send')}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                    props.canSend && !props.controlsDisabled ? 'bg-black text-white' : 'bg-[#C0C0C0] text-white'
                } disabled:cursor-not-allowed`}
            >
                <SendIcon />
            </ComposerPrimitive.Send>
        </div>
    )
}
