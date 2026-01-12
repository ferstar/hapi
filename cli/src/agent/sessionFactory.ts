import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import { resolve } from 'node:path'

import { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/apiSession'
import type { AgentState, MachineMetadata, Metadata, Session } from '@/api/types'
import { notifyDaemonSessionStarted } from '@/daemon/controlClient'
import type { WorktreeInfo } from '@/daemon/worktree'
import { readSettings } from '@/persistence'
import { configuration } from '@/configuration'
import { logger } from '@/ui/logger'
import { runtimePath } from '@/projectPath'
import { hashObject } from '@/utils/deterministicJson'
import { readWorktreeEnv } from '@/utils/worktreeEnv'
import packageJson from '../../package.json'

export type SessionStartedBy = 'daemon' | 'terminal'

export type SessionBootstrapOptions = {
    flavor: string
    startedBy?: SessionStartedBy
    workingDirectory?: string
    tag?: string
    forceNewSession?: boolean
    agentState?: AgentState | null
    sessionId?: string
}

export type SessionBootstrapResult = {
    api: ApiClient
    session: ApiSessionClient
    sessionInfo: Session
    metadata: Metadata
    machineId: string
    startedBy: SessionStartedBy
    workingDirectory: string
}

export function buildMachineMetadata(): MachineMetadata {
    return {
        host: os.hostname(),
        platform: os.platform(),
        happyCliVersion: packageJson.version,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: runtimePath()
    }
}

export function buildSessionMetadata(options: {
    flavor: string
    startedBy: SessionStartedBy
    workingDirectory: string
    machineId: string
    worktreeInfo?: WorktreeInfo | null
    now?: number
}): Metadata {
    const happyLibDir = runtimePath()
    const worktreeInfo = options.worktreeInfo ?? readWorktreeEnv()
    const now = options.now ?? Date.now()

    return {
        path: options.workingDirectory,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: options.machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir,
        happyToolsDir: resolve(happyLibDir, 'tools', 'unpacked'),
        startedFromDaemon: options.startedBy === 'daemon',
        hostPid: process.pid,
        startedBy: options.startedBy,
        lifecycleState: 'running',
        lifecycleStateSince: now,
        flavor: options.flavor,
        worktree: worktreeInfo ?? undefined
    }
}

function resolveProjectRoot(workingDirectory: string): string {
    const normalized = normalizePath(workingDirectory)
    try {
        const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: normalized,
            encoding: 'utf8'
        }).trim()
        if (!root) {
            return normalized
        }
        return normalizePath(root)
    } catch {
        return normalized
    }
}

function normalizePath(targetPath: string): string {
    try {
        return realpathSync(targetPath)
    } catch {
        return resolve(targetPath)
    }
}

function buildDefaultSessionTag(options: {
    flavor: string
    machineId: string
    projectRoot: string
    worktreeInfo?: WorktreeInfo | null
}): string {
    const payload = {
        v: 1,
        flavor: options.flavor,
        machineId: options.machineId,
        projectRoot: options.projectRoot,
        worktree: options.worktreeInfo
            ? {
                basePath: options.worktreeInfo.basePath,
                worktreePath: options.worktreeInfo.worktreePath,
                branch: options.worktreeInfo.branch,
                name: options.worktreeInfo.name
            }
            : null
    }
    const digest = hashObject(payload, undefined, 'base64url')
    return `hapi:${options.flavor}:${digest}`
}

async function getMachineIdOrExit(): Promise<string> {
    const settings = await readSettings()
    const machineId = settings?.machineId
    if (!machineId) {
        console.error(`[START] No machine ID found in settings, which is unexpected since authAndSetupMachineIfNeeded should have created it. Please report this issue on ${packageJson.bugs}`)
        process.exit(1)
    }
    logger.debug(`Using machineId: ${machineId}`)
    return machineId
}

async function reportSessionStarted(sessionId: string, metadata: Metadata): Promise<void> {
    try {
        logger.debug(`[START] Reporting session ${sessionId} to daemon`)
        const result = await notifyDaemonSessionStarted(sessionId, metadata)
        if (result?.error) {
            logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error)
        } else {
            logger.debug(`[START] Reported session ${sessionId} to daemon`)
        }
    } catch (error) {
        logger.debug('[START] Failed to report to daemon (may not be running):', error)
    }
}

export async function bootstrapSession(options: SessionBootstrapOptions): Promise<SessionBootstrapResult> {
    const workingDirectory = options.workingDirectory ?? process.cwd()
    const startedBy = options.startedBy ?? 'terminal'
    const agentState = options.agentState === undefined ? {} : options.agentState
    const sessionIdOverride = (() => {
        const fromEnv = process.env.HAPI_SESSION_ID?.trim()
        if (fromEnv) {
            return fromEnv
        }
        return options.sessionId
    })()

    const api = await ApiClient.create()

    const machineId = await getMachineIdOrExit()
    const worktreeInfo = readWorktreeEnv()
    const projectRoot = worktreeInfo?.worktreePath ?? resolveProjectRoot(workingDirectory)
    const envTag = process.env.HAPI_SESSION_TAG?.trim()
    const sessionTag = options.tag
        ?? (options.forceNewSession ? randomUUID() : undefined)
        ?? envTag
        ?? buildDefaultSessionTag({
            flavor: options.flavor,
            machineId,
            projectRoot,
            worktreeInfo
        })
    await api.getOrCreateMachine({
        machineId,
        metadata: buildMachineMetadata()
    })

    const metadata = buildSessionMetadata({
        flavor: options.flavor,
        startedBy,
        workingDirectory,
        machineId,
        worktreeInfo
    })

    let sessionInfo: Session | null = null
    if (sessionIdOverride) {
        try {
            sessionInfo = await api.getSessionById(sessionIdOverride)
            logger.debug(`[START] Loaded existing session by ID: ${sessionInfo.id}`)
        } catch (error) {
            logger.debug(`[START] Failed to load session ${sessionIdOverride}, falling back to tag`, error)
        }
    }

    if (!sessionInfo) {
        sessionInfo = await api.getOrCreateSession({
            tag: sessionTag,
            metadata,
            state: agentState
        })
        logger.debug(`Session created: ${sessionInfo.id}`)
    } else {
        logger.debug(`[START] Using existing session: ${sessionInfo.id}`)
    }

    const session = api.sessionSyncClient(sessionInfo)

    await reportSessionStarted(sessionInfo.id, metadata)

    return {
        api,
        session,
        sessionInfo,
        metadata,
        machineId,
        startedBy,
        workingDirectory
    }
}
