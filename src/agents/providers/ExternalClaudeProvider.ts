import * as fs from 'fs';
import * as path from 'path';
import { getClaudeProjectsRoot } from '../../claudePaths.js';
import type { PixelAgentsLogger } from '../logger.js';
import type { AgentProvider } from '../provider.js';
import { AgentRegistry } from '../registry.js';
import { ProcessScanner } from '../processScanner.js';
import type { TerminalController } from '../terminalController.js';
import { ClaudeTranscriptWatcher } from '../claudeTranscriptWatcher.js';
import { listTerminalSessions } from '../terminalProcessUtils.js';
import { AGENT_FRAMEWORK, AGENT_SOURCE, UNIFIED_AGENT_STATE } from '../types.js';
import type { AgentObservation } from '../types.js';

interface ExternalClaudeSession {
	commandLine: string;
	cwd?: string;
	elapsedSeconds: number;
	firstSeenAt: number;
	pid: number;
	providerSessionId: string;
	sessionId?: string;
	transcriptPath?: string;
	transcriptSnapshot: {
		state: AgentObservation['state'];
		subagents: AgentObservation['subagents'];
		tools: AgentObservation['tools'];
	};
	transcriptWatcher: ClaudeTranscriptWatcher | null;
}

interface ExternalClaudeProviderOptions {
	enableTranscriptCorrelation: boolean;
	scanIntervalMs: number;
	terminalController?: TerminalController;
}

export class ExternalClaudeProvider implements AgentProvider {
	readonly id = 'external-claude';

	private readonly sessions = new Map<string, ExternalClaudeSession>();
	private readonly transcriptCache = new Map<string, string>();
	private scanTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly registry: AgentRegistry,
		private readonly scanner: ProcessScanner,
		private readonly logger: PixelAgentsLogger,
		private readonly options: ExternalClaudeProviderOptions,
	) {}

	start(): void {
		if (process.platform !== 'darwin' || this.scanTimer) {
			return;
		}

		void this.scanNow();
		this.scanTimer = setInterval(() => {
			void this.scanNow();
		}, this.options.scanIntervalMs);
	}

	dispose(): void {
		if (this.scanTimer) {
			clearInterval(this.scanTimer);
			this.scanTimer = null;
		}
		for (const session of this.sessions.values()) {
			session.transcriptWatcher?.dispose();
		}
		this.sessions.clear();
		this.registry.clearProvider(this.id, true);
	}

	async focusSession(providerSessionId: string): Promise<void> {
		const session = this.sessions.get(providerSessionId);
		if (!session || !this.options.terminalController) {
			return;
		}
		await this.options.terminalController.focusProcess(session.pid);
	}

	closeSession(providerSessionId: string): void {
		const session = this.sessions.get(providerSessionId);
		if (!session || !this.options.terminalController) {
			return;
		}
		this.options.terminalController.terminateProcess(session.pid);
	}

	private async scanNow(): Promise<void> {
		const processes = await this.scanner.scan();
		const observations: AgentObservation[] = [];
		const liveSessionIds = new Set<string>();
		const terminalSessions = listTerminalSessions(processes);

		for (const terminalSession of terminalSessions) {
			if (terminalSession.kind !== 'agent' || !isClaudeProcess(terminalSession.commandLine, terminalSession.executable)) {
				continue;
			}

			const providerSessionId = `pid:${terminalSession.pid}`;
			liveSessionIds.add(providerSessionId);
			const session = this.getOrCreateSession(providerSessionId, terminalSession.pid);
			session.commandLine = terminalSession.commandLine;
			session.cwd = terminalSession.cwd;
			session.elapsedSeconds = terminalSession.elapsedSeconds;
			session.sessionId = extractSessionId(terminalSession.commandLine) ?? session.sessionId;

			if (this.options.enableTranscriptCorrelation && session.sessionId && !session.transcriptPath) {
				session.transcriptPath = this.findTranscriptPath(session.sessionId);
				if (session.transcriptPath) {
					this.logger.debug('Correlated external Claude session to transcript', {
						pid: session.pid,
						sessionId: session.sessionId,
						transcriptPath: session.transcriptPath,
					});
					this.startTranscriptWatcher(session);
				}
			}

			observations.push(this.toObservation(session));
		}

		for (const [providerSessionId, session] of [...this.sessions]) {
			if (liveSessionIds.has(providerSessionId)) {
				continue;
			}
			session.transcriptWatcher?.dispose();
			session.transcriptWatcher = null;
			this.sessions.delete(providerSessionId);
		}

		this.logger.debug('Scanned external Claude sessions', { count: observations.length });
		this.registry.replaceProviderSnapshot(this.id, observations);
	}

	private getOrCreateSession(providerSessionId: string, pid: number): ExternalClaudeSession {
		const existing = this.sessions.get(providerSessionId);
		if (existing) {
			return existing;
		}

		const session: ExternalClaudeSession = {
			commandLine: '',
			elapsedSeconds: 0,
			firstSeenAt: Date.now(),
			pid,
			providerSessionId,
			transcriptSnapshot: {
				state: UNIFIED_AGENT_STATE.UNKNOWN,
				subagents: [],
				tools: [],
			},
			transcriptWatcher: null,
		};
		this.sessions.set(providerSessionId, session);
		return session;
	}

	private startTranscriptWatcher(session: ExternalClaudeSession): void {
		if (!session.transcriptPath) {
			return;
		}

		session.transcriptWatcher?.dispose();
		session.transcriptWatcher = new ClaudeTranscriptWatcher({
			filePath: session.transcriptPath,
			logger: this.logger,
			onUpdate: (snapshot) => {
				session.transcriptSnapshot = snapshot;
				this.registry.upsertObservation(this.toObservation(session));
			},
			readFromEnd: true,
			watcherId: session.providerSessionId,
		});
		session.transcriptWatcher.start();
	}

	private findTranscriptPath(sessionId: string): string | undefined {
		const cached = this.transcriptCache.get(sessionId);
		if (cached && fs.existsSync(cached)) {
			return cached;
		}

		const projectsRoot = getClaudeProjectsRoot();
		let projectEntries: fs.Dirent[];
		try {
			projectEntries = fs.readdirSync(projectsRoot, { withFileTypes: true });
		} catch {
			return undefined;
		}

		for (const entry of projectEntries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const candidatePath = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`);
			if (!fs.existsSync(candidatePath)) {
				continue;
			}
			this.transcriptCache.set(sessionId, candidatePath);
			return candidatePath;
		}

		return undefined;
	}

	private toObservation(session: ExternalClaudeSession): AgentObservation {
		const transcriptState = session.transcriptSnapshot.state;
		const state = transcriptState === UNIFIED_AGENT_STATE.UNKNOWN
			&& session.transcriptSnapshot.tools.length === 0
			&& session.transcriptSnapshot.subagents.length === 0
			? UNIFIED_AGENT_STATE.RUNNING
			: transcriptState;

		return {
			capabilities: {
				closable: Boolean(this.options.terminalController),
				focusable: Boolean(this.options.terminalController),
			},
			framework: AGENT_FRAMEWORK.CLAUDE,
			identityKeys: [
				session.sessionId ? `claude-session:${session.sessionId}` : '',
				session.transcriptPath ? `claude-transcript:${session.transcriptPath}` : '',
				`external-claude-pid:${session.pid}`,
			].filter(Boolean),
			metadata: {
				commandLine: session.commandLine,
				cwd: session.cwd,
				folderName: session.cwd ? path.basename(session.cwd) : undefined,
				jsonlFile: session.transcriptPath,
				pid: session.pid,
				sessionId: session.sessionId,
			},
			priority: 60,
			providerId: this.id,
			providerSessionId: session.providerSessionId,
			source: AGENT_SOURCE.EXTERNAL_TERMINAL,
			state,
			subagents: session.transcriptSnapshot.subagents,
			tools: session.transcriptSnapshot.tools,
		};
	}
}

function extractSessionId(commandLine: string): string | undefined {
	const match = commandLine.match(/--session-id(?:=|\s+)([A-Za-z0-9-]+)/);
	return match?.[1];
}

function isClaudeProcess(commandLine: string, executable: string): boolean {
	const haystack = `${executable} ${commandLine}`.toLowerCase();
	return /(^|\s|\/)(claude|claude-code)(\s|$)/.test(haystack);
}
