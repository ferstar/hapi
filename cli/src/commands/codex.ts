import chalk from 'chalk'
import { z } from 'zod'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import type { CodexPermissionMode } from '@hapi/protocol/types'

export const codexCommand: CommandDefinition = {
    name: 'codex',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const { runCodex } = await import('@/codex/runCodex')

            const options: {
                startedBy?: 'daemon' | 'terminal'
                codexArgs?: string[]
                permissionMode?: CodexPermissionMode
                forceNewSession?: boolean
                sessionTag?: string
                resumeSessionId?: string
                forceNewSession?: boolean
                sessionTag?: string
                resumeSessionId?: string
            } = {}
            const unknownArgs: string[] = []

            for (let i = 0; i < commandArgs.length; i++) {
                const arg = commandArgs[i]
                if (i === 0 && arg === 'resume') {
                    const candidate = commandArgs[i + 1]
                    if (!candidate || candidate.startsWith('-')) {
                        throw new Error('resume requires a session id')
                    }
                    options.resumeSessionId = candidate
                    i += 1
                    continue
                }
                if (arg === '--started-by') {
                    options.startedBy = commandArgs[++i] as 'daemon' | 'terminal'
                } else if (arg === '--resume') {
                    options.resumeSessionId = z.string().min(1).parse(commandArgs[++i])
                } else if (arg === '--session-tag') {
                    options.sessionTag = z.string().min(1).parse(commandArgs[++i])
                } else if (arg === 'resume') {
                    const resumeId = commandArgs[i + 1]
                    if (resumeId && !resumeId.startsWith('-')) {
                        options.resumeSessionId = z.string().min(1).parse(resumeId)
                        i += 1
                    } else {
                        unknownArgs.push(arg)
                    }
                } else if (arg === '--new-session') {
                    options.forceNewSession = true
                } else if (arg === '--yolo' || arg === '--dangerously-bypass-approvals-and-sandbox') {
                    options.permissionMode = 'yolo'
                    unknownArgs.push(arg)
                } else {
                    unknownArgs.push(arg)
                }
            }
            if (unknownArgs.length > 0) {
                options.codexArgs = unknownArgs
            }

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()
            await runCodex(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
