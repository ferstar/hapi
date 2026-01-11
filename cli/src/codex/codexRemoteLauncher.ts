import React from 'react';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import { join } from 'node:path';

import { CodexMcpClient } from './codexMcpClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { logger } from '@/ui/logger';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import type { CodexSessionConfig } from './types';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { emitReadyIfIdle } from './utils/emitReadyIfIdle';
import type { CodexSession } from './session';
import type { EnhancedMode } from './loop';
import { hasCodexCliOverrides } from './utils/codexCliOverrides';
import { buildCodexStartConfig } from './utils/codexStartConfig';
import { convertCodexEvent } from './utils/codexEventConverter';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';

type HappyServer = Awaited<ReturnType<typeof buildHapiMcpBridge>>['server'];

function resolveEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

class CodexRemoteLauncher extends RemoteLauncherBase {
    private static readonly STALL_TIMEOUT_MIN_MS = resolveEnvNumber('HAPI_CODEX_STALL_MIN_MS', 120_000);
    private static readonly STALL_TIMEOUT_THINKING_MS = resolveEnvNumber('HAPI_CODEX_STALL_THINKING_MS', 240_000);
    private static readonly STALL_TIMEOUT_TOOL_MS = resolveEnvNumber('HAPI_CODEX_STALL_TOOL_MS', 300_000);
    private static readonly STALL_TIMEOUT_TOOL_ACTIVE_MS = resolveEnvNumber('HAPI_CODEX_STALL_TOOL_ACTIVE_MS', 600_000);
    private static readonly STALL_TIMEOUT_PATCH_MS = resolveEnvNumber('HAPI_CODEX_STALL_PATCH_MS', 300_000);
    private static readonly STALL_TIMEOUT_PATCH_ACTIVE_MS = resolveEnvNumber('HAPI_CODEX_STALL_PATCH_ACTIVE_MS', 600_000);
    private static readonly STALL_TIMEOUT_COMPLETE_MS = resolveEnvNumber('HAPI_CODEX_STALL_COMPLETE_MS', 180_000);
    private static readonly STALL_CHECK_INTERVAL_MS = resolveEnvNumber('HAPI_CODEX_STALL_CHECK_MS', 5_000);
    private static readonly STALL_RESTART_LIMIT = resolveEnvNumber('HAPI_CODEX_STALL_RESTART_LIMIT', 3);
    private static readonly STALL_RESTART_COOLDOWN_MS = resolveEnvNumber('HAPI_CODEX_STALL_RESTART_COOLDOWN_MS', 15 * 60_000);
    private static readonly CONNECT_TIMEOUT_MS = resolveEnvNumber('HAPI_CODEX_CONNECT_TIMEOUT_MS', 60_000);
    private readonly session: CodexSession;
    private readonly client: CodexMcpClient;
    private permissionHandler: CodexPermissionHandler | null = null;
    private reasoningProcessor: ReasoningProcessor | null = null;
    private diffProcessor: DiffProcessor | null = null;
    private happyServer: HappyServer | null = null;
    private abortController: AbortController = new AbortController();
    private storedSessionIdForResume: string | null = null;
    private lastEventAt = Date.now();
    private currentPhase: 'idle' | 'request' | 'thinking' | 'tool' | 'patch' | 'complete' = 'idle';
    private inFlight = false;
    private stallCheckTimer: NodeJS.Timeout | null = null;
    private stallRestartInProgress = false;
    private stallRestartCount = 0;
    private stallRestartedAtMs: number | null = null;
    private ignoreEventsUntilNextRequest = false;
    private activeToolCalls = 0;
    private activePatchCalls = 0;

    constructor(session: CodexSession) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.client = new CodexMcpClient();
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(CodexDisplay, context);
    }

    private async handleAbort(options?: { resetQueue?: boolean }): Promise<void> {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            if (this.client.hasActiveSession()) {
                this.storedSessionIdForResume = this.client.storeSessionForResume();
                logger.debug('[Codex] Stored session for resume:', this.storedSessionIdForResume);
            }

            this.abortController.abort();
            logger.debug(`[Codex] Abort signal set (resetQueue=${options?.resetQueue ? 'yes' : 'no'})`);
            if (options?.resetQueue) {
                this.session.queue.reset();
            }
            this.permissionHandler?.reset();
            this.reasoningProcessor?.abort();
            this.diffProcessor?.reset();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            this.abortController = new AbortController();
        }
    }

    private setPhase(phase: 'idle' | 'request' | 'thinking' | 'tool' | 'patch' | 'complete'): void {
        this.currentPhase = phase;
    }

    private markEvent(): void {
        this.lastEventAt = Date.now();
        if (this.stallRestartInProgress) {
            this.stallRestartInProgress = false;
        }
    }

    private getPhaseTimeoutMs(): number {
        switch (this.currentPhase) {
            case 'tool':
                return this.activeToolCalls > 0
                    ? CodexRemoteLauncher.STALL_TIMEOUT_TOOL_ACTIVE_MS
                    : CodexRemoteLauncher.STALL_TIMEOUT_TOOL_MS;
            case 'patch':
                return this.activePatchCalls > 0
                    ? CodexRemoteLauncher.STALL_TIMEOUT_PATCH_ACTIVE_MS
                    : CodexRemoteLauncher.STALL_TIMEOUT_PATCH_MS;
            case 'thinking':
                return CodexRemoteLauncher.STALL_TIMEOUT_THINKING_MS;
            case 'complete':
                return CodexRemoteLauncher.STALL_TIMEOUT_COMPLETE_MS;
            case 'request':
            case 'idle':
            default:
                return CodexRemoteLauncher.STALL_TIMEOUT_MIN_MS;
        }
    }

    private startStallMonitor(): void {
        if (this.stallCheckTimer) return;
        this.stallCheckTimer = setInterval(() => {
            if (!this.inFlight || this.stallRestartInProgress) return;
            if (
                this.stallRestartedAtMs &&
                Date.now() - this.stallRestartedAtMs > CodexRemoteLauncher.STALL_RESTART_COOLDOWN_MS
            ) {
                this.stallRestartCount = 0;
                this.stallRestartedAtMs = null;
            }
            const idleMs = Date.now() - this.lastEventAt;
            if (idleMs < this.getPhaseTimeoutMs()) return;
            void this.triggerStallRestart(`no events for ${Math.round(idleMs / 1000)}s`);
        }, CodexRemoteLauncher.STALL_CHECK_INTERVAL_MS);
    }

    private stopStallMonitor(): void {
        if (this.stallCheckTimer) {
            clearInterval(this.stallCheckTimer);
            this.stallCheckTimer = null;
        }
    }

    private async triggerStallRestart(reason: string): Promise<void> {
        if (this.stallRestartInProgress) return;
        if (this.stallRestartCount >= CodexRemoteLauncher.STALL_RESTART_LIMIT) {
            logger.warn('[Codex] Stall detected but restart limit reached; skipping');
            return;
        }
        this.stallRestartInProgress = true;
        this.stallRestartCount += 1;
        this.stallRestartedAtMs = Date.now();
        this.ignoreEventsUntilNextRequest = true;
        logger.warn(`[Codex] Stall detected (${reason}); restarting MCP client`);
        this.messageBuffer.addMessage('Codex stalled; restarting...', 'status');
        this.session.sendSessionEvent({ type: 'message', message: 'Codex stalled; restarting...' });

        try {
            if (this.client.hasActiveSession()) {
                this.storedSessionIdForResume = this.client.storeSessionForResume();
                logger.debug('[Codex] Stored session for resume after stall:', this.storedSessionIdForResume);
            }
            this.abortController.abort();
            this.inFlight = false;
            await this.client.disconnect();
        } catch (error) {
            logger.warn('[Codex] Error while restarting MCP client', error);
        } finally {
            this.abortController = new AbortController();
            this.permissionHandler?.reset('Stalled restart');
            this.reasoningProcessor?.abort();
            this.diffProcessor?.reset();
            this.setPhase('idle');
            this.activeToolCalls = 0;
            this.activePatchCalls = 0;
        }
    }


    private async handleExitFromUi(): Promise<void> {
        logger.debug('[codex-remote]: Exiting agent via Ctrl-C');
        this.exitReason = 'exit';
        this.shouldExit = true;
        await this.handleAbort({ resetQueue: true });
    }

    private async handleSwitchFromUi(): Promise<void> {
        logger.debug('[codex-remote]: Switching to local mode via double space');
        this.exitReason = 'switch';
        this.shouldExit = true;
        await this.handleAbort({ resetQueue: true });
    }

    private async handleSwitchRequest(): Promise<void> {
        this.exitReason = 'switch';
        this.shouldExit = true;
        await this.handleAbort({ resetQueue: true });
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        if (this.session.codexArgs && this.session.codexArgs.length > 0) {
            if (hasCodexCliOverrides(this.session.codexCliOverrides)) {
                logger.debug(`[codex-remote] CLI args include sandbox/approval overrides; other args ` +
                    `are ignored in remote mode.`);
            } else {
                logger.debug(`[codex-remote] Warning: CLI args [${this.session.codexArgs.join(', ')}] are ignored in remote mode. ` +
                    `Remote mode uses message-based configuration (model/sandbox set via web interface).`);
            }
        }

        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;
        const client = this.client;

        function findCodexResumeFile(sessionId: string | null): string | null {
            if (!sessionId) return null;
            try {
                const codexHomeDir = process.env.CODEX_HOME || join(os.homedir(), '.codex');
                const rootDir = join(codexHomeDir, 'sessions');

                function collectFilesRecursive(dir: string, acc: string[] = []): string[] {
                    let entries: fs.Dirent[];
                    try {
                        entries = fs.readdirSync(dir, { withFileTypes: true });
                    } catch {
                        return acc;
                    }
                    for (const entry of entries) {
                        const full = join(dir, entry.name);
                        if (entry.isDirectory()) {
                            collectFilesRecursive(full, acc);
                        } else if (entry.isFile()) {
                            acc.push(full);
                        }
                    }
                    return acc;
                }

                const candidates = collectFilesRecursive(rootDir)
                    .filter((full) => full.endsWith(`-${sessionId}.jsonl`))
                    .filter((full) => {
                        try { return fs.statSync(full).isFile(); } catch { return false; }
                    })
                    .sort((a, b) => {
                        const sa = fs.statSync(a).mtimeMs;
                        const sb = fs.statSync(b).mtimeMs;
                        return sb - sa;
                    });
                return candidates[0] || null;
            } catch {
                return null;
            }
        }

        const RESUME_CONTEXT_MAX_ITEMS = 40;
        const RESUME_CONTEXT_MAX_CHARS = 16000;
        const RESUME_CONTEXT_TOOL_MAX_CHARS = 2000;
        const RESUME_CONTEXT_REASONING_MAX_CHARS = 2000;

        function readResumeFileContent(resumeFile: string): { content: string; truncated: boolean } | null {
            try {
                const stat = fs.statSync(resumeFile);
                if (!stat.isFile()) {
                    return null;
                }
                return { content: fs.readFileSync(resumeFile, 'utf8'), truncated: false };
            } catch (error) {
                logger.debug('[Codex] Failed to read resume file:', error);
                return null;
            }
        }

        function safeStringify(value: unknown): string | null {
            if (value === null || value === undefined) {
                return null;
            }
            if (typeof value === 'string') {
                return value;
            }
            try {
                return JSON.stringify(value);
            } catch {
                return null;
            }
        }

        function formatResumeValue(value: unknown, maxChars: number, singleLine = false): string | null {
            const raw = safeStringify(value);
            if (!raw) {
                return null;
            }
            const normalized = singleLine ? raw.replace(/\s+/g, ' ').trim() : raw;
            if (!normalized) {
                return null;
            }
            if (normalized.length <= maxChars) {
                return normalized;
            }
            return `${normalized.slice(0, maxChars)}...`;
        }

        function buildResumeInstructionsFromFile(resumeFile: string): string | undefined {
            const result = readResumeFileContent(resumeFile);
            if (!result) {
                return undefined;
            }

            const items: { role: 'user' | 'assistant' | 'tool'; text: string }[] = [];
            let truncated = result.truncated;

            const lines = result.content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                try {
                    const parsed = JSON.parse(trimmed);
                    const converted = convertCodexEvent(parsed);
                    if (converted?.userMessage) {
                        items.push({ role: 'user', text: converted.userMessage });
                    }
                    if (converted?.message?.type === 'message') {
                        items.push({ role: 'assistant', text: converted.message.message });
                    }
                    if (converted?.message?.type === 'reasoning') {
                        const reasoning = formatResumeValue(converted.message.message, RESUME_CONTEXT_REASONING_MAX_CHARS);
                        if (reasoning) {
                            items.push({ role: 'assistant', text: `Reasoning: ${reasoning}` });
                        }
                    }
                    if (converted?.message?.type === 'tool-call') {
                        const input = formatResumeValue(converted.message.input, RESUME_CONTEXT_TOOL_MAX_CHARS, true);
                        const text = input
                            ? `Call ${converted.message.name} ${input}`
                            : `Call ${converted.message.name}`;
                        items.push({ role: 'tool', text });
                    }
                    if (converted?.message?.type === 'tool-call-result') {
                        const output = formatResumeValue(converted.message.output, RESUME_CONTEXT_TOOL_MAX_CHARS, true);
                        if (output) {
                            items.push({ role: 'tool', text: `Result ${output}` });
                        }
                    }
                } catch {
                    continue;
                }
            }

            if (items.length === 0) {
                return undefined;
            }

            if (items.length > RESUME_CONTEXT_MAX_ITEMS) {
                items.splice(0, items.length - RESUME_CONTEXT_MAX_ITEMS);
                truncated = true;
            }

            const rendered = items.map((item) => {
                if (item.role === 'user') {
                    return `User: ${item.text}`;
                }
                if (item.role === 'tool') {
                    return `Tool: ${item.text}`;
                }
                return `Assistant: ${item.text}`;
            });
            let totalChars = rendered.reduce((sum, line) => sum + line.length + 1, 0);
            while (rendered.length > 1 && totalChars > RESUME_CONTEXT_MAX_CHARS) {
                const removed = rendered.shift();
                totalChars -= (removed?.length ?? 0) + 1;
                truncated = true;
            }

            if (rendered.length === 0) {
                return undefined;
            }

            const header = truncated
                ? 'Continue from the prior session context below (transcript truncated):'
                : 'Continue from the prior session context below:';
            return `${header}\n${rendered.join('\n')}`;
        }

        const permissionHandler = new CodexPermissionHandler(session.client);
        const reasoningProcessor = new ReasoningProcessor((message) => {
            session.sendCodexMessage(message);
        });
        const diffProcessor = new DiffProcessor((message) => {
            session.sendCodexMessage(message);
        });
        this.permissionHandler = permissionHandler;
        this.reasoningProcessor = reasoningProcessor;
        this.diffProcessor = diffProcessor;

        client.setPermissionHandler(permissionHandler);
        client.setHandler((msg) => {
            if (this.ignoreEventsUntilNextRequest && !this.inFlight) {
                logger.debug('[Codex] Ignoring event during restart');
                return;
            }
            this.markEvent();
            logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

            const msgType = typeof msg?.type === 'string' ? msg.type : null;
            if (msgType === 'event_msg' || msgType === 'response_item' || msgType === 'session_meta') {
                const payloadType = typeof msg?.payload?.type === 'string' ? msg.payload.type : null;
                logger.debug(`[Codex] MCP wrapper event type: ${msgType}${payloadType ? ` (payload=${payloadType})` : ''}`);
            }

            if (msg.type === 'agent_message') {
                messageBuffer.addMessage(msg.message, 'assistant');
                this.setPhase('complete');
            } else if (msg.type === 'agent_reasoning_delta') {
                this.setPhase('thinking');
            } else if (msg.type === 'agent_reasoning') {
                messageBuffer.addMessage(`[Thinking] ${msg.text.substring(0, 100)}...`, 'system');
                this.setPhase('thinking');
            } else if (msg.type === 'exec_command_begin') {
                messageBuffer.addMessage(`Executing: ${msg.command}`, 'tool');
                this.activeToolCalls += 1;
                this.setPhase('tool');
            } else if (msg.type === 'exec_command_end') {
                const output = msg.output || msg.error || 'Command completed';
                const truncatedOutput = output.substring(0, 200);
                messageBuffer.addMessage(
                    `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                    'result'
                );
                this.activeToolCalls = Math.max(0, this.activeToolCalls - 1);
                this.setPhase('thinking');
            } else if (msg.type === 'task_started') {
                messageBuffer.addMessage('Starting task...', 'status');
                this.setPhase('thinking');
            } else if (msg.type === 'task_complete') {
                messageBuffer.addMessage('Task completed', 'status');
                sendReady();
                this.setPhase('complete');
                if (this.stallRestartCount > 0) {
                    this.stallRestartCount = 0;
                    this.stallRestartedAtMs = null;
                }
            } else if (msg.type === 'turn_aborted') {
                messageBuffer.addMessage('Turn aborted', 'status');
                sendReady();
                this.setPhase('complete');
            }

            if (msg.type === 'task_started') {
                if (!session.thinking) {
                    logger.debug('thinking started');
                    session.onThinkingChange(true);
                }
            }
            if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                if (session.thinking) {
                    logger.debug('thinking completed');
                    session.onThinkingChange(false);
                }
                diffProcessor.reset();
            }
            if (msg.type === 'agent_reasoning_section_break') {
                reasoningProcessor.handleSectionBreak();
            }
            if (msg.type === 'agent_reasoning_delta') {
                reasoningProcessor.processDelta(msg.delta);
            }
            if (msg.type === 'agent_reasoning') {
                reasoningProcessor.complete(msg.text);
            }
            if (msg.type === 'agent_message') {
                session.sendCodexMessage({
                    type: 'message',
                    message: msg.message,
                    id: randomUUID()
                });
            }
            if (msg.type === 'exec_command_begin' || msg.type === 'exec_approval_request') {
                const { call_id, type, ...inputs } = msg;
                session.sendCodexMessage({
                    type: 'tool-call',
                    name: 'CodexBash',
                    callId: call_id,
                    input: inputs,
                    id: randomUUID()
                });
                this.setPhase('tool');
            }
            if (msg.type === 'exec_command_end') {
                const { call_id, type, ...output } = msg;
                session.sendCodexMessage({
                    type: 'tool-call-result',
                    callId: call_id,
                    output: output,
                    id: randomUUID()
                });
            }
            if (msg.type === 'token_count') {
                session.sendCodexMessage({
                    ...msg,
                    id: randomUUID()
                });
            }
            if (msg.type === 'patch_apply_begin') {
                const { call_id, auto_approved, changes } = msg;

                const changeCount = Object.keys(changes).length;
                const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
                messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
                this.activePatchCalls += 1;
                this.setPhase('patch');

                session.sendCodexMessage({
                    type: 'tool-call',
                    name: 'CodexPatch',
                    callId: call_id,
                    input: {
                        auto_approved,
                        changes
                    },
                    id: randomUUID()
                });
            }
            if (msg.type === 'patch_apply_end') {
                const { call_id, stdout, stderr, success } = msg;

                if (success) {
                    const message = stdout || 'Files modified successfully';
                    messageBuffer.addMessage(message.substring(0, 200), 'result');
                } else {
                    const errorMsg = stderr || 'Failed to modify files';
                    messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
                }

                session.sendCodexMessage({
                    type: 'tool-call-result',
                    callId: call_id,
                    output: {
                        stdout,
                        stderr,
                        success
                    },
                    id: randomUUID()
                });
                this.activePatchCalls = Math.max(0, this.activePatchCalls - 1);
                this.setPhase('thinking');
            }
            if (msg.type === 'turn_diff') {
                if (msg.unified_diff) {
                    diffProcessor.processDiff(msg.unified_diff);
                }
            }
        });

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
        this.happyServer = happyServer;

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort({ resetQueue: true }),
            onSwitch: () => this.handleSwitchRequest()
        });

        this.startStallMonitor();

        function logActiveHandles(tag: string) {
            if (!process.env.DEBUG) return;
            const anyProc: any = process as any;
            const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
            const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
            logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
            try {
                const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
                logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
            } catch {}
        }

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        const syncSessionId = () => {
            const clientSessionId = client.getSessionId();
            if (clientSessionId && clientSessionId !== session.sessionId) {
                session.onSessionFound(clientSessionId);
            }
        };

        try {
            await this.client.connect(CodexRemoteLauncher.CONNECT_TIMEOUT_MS);
        } catch (error) {
            logger.warn('[Codex] Initial MCP connect failed', error);
            await this.client.disconnect().catch(() => {});
            throw error;
        }

        let wasCreated = false;
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
        let nextExperimentalResume: string | null = null;
        let first = true;
        let idleAbortStreak = 0;

        while (!this.shouldExit) {
            logActiveHandles('loop-top');
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                const waitSignal = this.abortController.signal;
                const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    if (waitSignal.aborted && !this.shouldExit) {
                        idleAbortStreak += 1;
                        const backoffMs = Math.min(2000, 50 * idleAbortStreak);
                        logger.debug(
                            `[codex]: Wait aborted while idle; ignoring and continuing (streak=${idleAbortStreak}, backoff=${backoffMs}ms)`
                        );
                        await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
                        if (idleAbortStreak >= 20) {
                            logger.warn('[Codex] Excessive idle aborts; resetting queue to avoid hot loop');
                            await this.handleAbort({ resetQueue: true });
                            idleAbortStreak = 0;
                        }
                        continue;
                    }
                    idleAbortStreak = 0;
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${this.shouldExit}`);
                    break;
                }
                idleAbortStreak = 0;
                message = batch;
            }

            if (!message) {
                break;
            }

            if (wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Codex] Mode changed – restarting Codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                try {
                    const prevSessionId = client.getSessionId();
                    nextExperimentalResume = findCodexResumeFile(prevSessionId);
                    if (nextExperimentalResume) {
                        logger.debug(`[Codex] Found resume file for session ${prevSessionId}: ${nextExperimentalResume}`);
                        messageBuffer.addMessage('Resuming previous context…', 'status');
                    } else {
                        logger.debug('[Codex] No resume file found for previous session');
                    }
                } catch (error) {
                    logger.debug('[Codex] Error while searching resume file', error);
                }
                client.clearSession();
                wasCreated = false;
                currentModeHash = null;
                pending = message;
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                session.onThinkingChange(false);
                continue;
            }

            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;

            try {
                if (!wasCreated) {
                    let resumeFile: string | null = null;
                    if (nextExperimentalResume) {
                        resumeFile = nextExperimentalResume;
                        nextExperimentalResume = null;
                        logger.debug('[Codex] Using resume file from mode change:', resumeFile);
                    } else if (this.storedSessionIdForResume) {
                        const abortResumeFile = findCodexResumeFile(this.storedSessionIdForResume);
                        if (abortResumeFile) {
                            resumeFile = abortResumeFile;
                            logger.debug('[Codex] Using resume file from aborted session:', resumeFile);
                            messageBuffer.addMessage('Resuming from aborted session...', 'status');
                        } else if (this.stallRestartInProgress) {
                            messageBuffer.addMessage('Resume file missing; starting fresh.', 'status');
                            session.sendSessionEvent({ type: 'message', message: 'Resume file missing; starting fresh.' });
                        }
                        this.storedSessionIdForResume = null;
                    } else if (first && session.sessionId) {
                        const localResumeFile = findCodexResumeFile(session.sessionId);
                        if (localResumeFile) {
                            resumeFile = localResumeFile;
                            logger.debug('[Codex] Using resume file from local session:', localResumeFile);
                            messageBuffer.addMessage('Resuming from local session log...', 'status');
                        }
                    }

                    const developerInstructions = resumeFile
                        ? buildResumeInstructionsFromFile(resumeFile)
                        : undefined;
                    const startConfig: CodexSessionConfig = buildCodexStartConfig({
                        message: message.message,
                        mode: message.mode,
                        first,
                        mcpServers,
                        cliOverrides: session.codexCliOverrides,
                        developerInstructions
                    });

                    if (resumeFile) {
                        (startConfig.config as any).experimental_resume = resumeFile;
                    }

                    if (this.stallRestartInProgress) {
                        logger.debug('[Codex] Clearing stall restart flag before new request');
                        this.stallRestartInProgress = false;
                    }
                    this.inFlight = true;
                    this.ignoreEventsUntilNextRequest = false;
                    this.setPhase('request');
                    this.lastEventAt = Date.now();
                    await client.startSession(startConfig, { signal: this.abortController.signal });
                    wasCreated = true;
                    first = false;
                    syncSessionId();
                } else {
                    if (this.abortController.signal.aborted) {
                        logger.debug('[Codex] Continue called while abort signal already set');
                    }
                    if (this.stallRestartInProgress) {
                        logger.debug('[Codex] Clearing stall restart flag before new request');
                        this.stallRestartInProgress = false;
                    }
                    this.inFlight = true;
                    this.ignoreEventsUntilNextRequest = false;
                    this.setPhase('request');
                    this.lastEventAt = Date.now();
                    await client.continueSession(message.message, { signal: this.abortController.signal });
                    syncSessionId();
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';

                if (this.stallRestartInProgress) {
                    messageBuffer.addMessage('Codex stalled; restarting...', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Codex stalled; restarting...' });
                    wasCreated = false;
                    currentModeHash = null;
                    this.setPhase('idle');
                } else if (isAbortError) {
                    logger.debug('[Codex] AbortError caught in run loop');
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    wasCreated = false;
                    currentModeHash = null;
                    logger.debug('[Codex] Marked session as not created after abort for proper resume');
                    this.setPhase('idle');
                } else {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    if (client.hasActiveSession()) {
                        this.storedSessionIdForResume = client.storeSessionForResume();
                        logger.debug('[Codex] Stored session after unexpected error:', this.storedSessionIdForResume);
                    }
                }
            } finally {
                this.inFlight = false;
                this.setPhase('idle');
                this.activeToolCalls = 0;
                this.activePatchCalls = 0;
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                session.onThinkingChange(false);
                emitReadyIfIdle({
                    pending,
                    queueSize: () => session.queue.size(),
                    shouldExit: this.shouldExit,
                    sendReady
                });
                logActiveHandles('after-turn');
            }
        }
    }

    protected async cleanup(): Promise<void> {
        logger.debug('[codex-remote]: cleanup start');
        this.stopStallMonitor();
        try {
            await this.client.disconnect();
        } catch (error) {
            logger.debug('[codex-remote]: Error disconnecting client', error);
        }

        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.happyServer) {
            this.happyServer.stop();
            this.happyServer = null;
        }

        this.permissionHandler?.reset();
        this.reasoningProcessor?.abort();
        this.diffProcessor?.reset();
        this.permissionHandler = null;
        this.reasoningProcessor = null;
        this.diffProcessor = null;

        logger.debug('[codex-remote]: cleanup done');
    }
}

export async function codexRemoteLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    const launcher = new CodexRemoteLauncher(session);
    return launcher.launch();
}
