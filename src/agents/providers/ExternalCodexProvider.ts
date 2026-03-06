import * as path from 'path';
import type { PixelAgentsLogger } from '../logger.js';
import type { AgentProvider } from '../provider.js';
import { AgentRegistry } from '../registry.js';
import { ProcessScanner } from '../processScanner.js';
import type { TerminalController } from '../terminalController.js';
import { listTerminalSessions } from '../terminalProcessUtils.js';
import { AGENT_FRAMEWORK, AGENT_SOURCE, UNIFIED_AGENT_STATE } from '../types.js';
import type { AgentObservation } from '../types.js';

interface ExternalCodexProviderOptions {
	scanIntervalMs: number;
	terminalController?: TerminalController;
}

interface ExternalCodexSession {
	commandLine: string;
	cwd?: string;
	firstSeenAt: number;
	pid: number;
	providerSessionId: string;
}

export class ExternalCodexProvider implements AgentProvider {
	readonly id = 'external-codex';

	private readonly sessions = new Map<string, ExternalCodexSession>();
	private scanTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly registry: AgentRegistry,
		private readonly scanner: ProcessScanner,
		private readonly logger: PixelAgentsLogger,
		private readonly options: ExternalCodexProviderOptions,
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
			if (terminalSession.kind !== 'agent' || !isCodexProcess(terminalSession.commandLine, terminalSession.executable)) {
				continue;
			}

			const providerSessionId = `pid:${terminalSession.pid}`;
			liveSessionIds.add(providerSessionId);
			const session = this.getOrCreateSession(providerSessionId, terminalSession.pid);
			session.commandLine = terminalSession.commandLine;
			session.cwd = terminalSession.cwd;
			observations.push(this.toObservation(session));
		}

		for (const providerSessionId of [...this.sessions.keys()]) {
			if (!liveSessionIds.has(providerSessionId)) {
				this.sessions.delete(providerSessionId);
			}
		}

		this.logger.debug('Scanned external Codex sessions', { count: observations.length });
		this.registry.replaceProviderSnapshot(this.id, observations);
	}

	private getOrCreateSession(providerSessionId: string, pid: number): ExternalCodexSession {
		const existing = this.sessions.get(providerSessionId);
		if (existing) {
			return existing;
		}

		const session: ExternalCodexSession = {
			commandLine: '',
			firstSeenAt: Date.now(),
			pid,
			providerSessionId,
		};
		this.sessions.set(providerSessionId, session);
		return session;
	}

	private toObservation(session: ExternalCodexSession): AgentObservation {
		return {
			capabilities: {
				closable: Boolean(this.options.terminalController),
				focusable: Boolean(this.options.terminalController),
			},
			framework: AGENT_FRAMEWORK.CODEX,
			identityKeys: [`external-codex-pid:${session.pid}`],
			metadata: {
				commandLine: session.commandLine,
				cwd: session.cwd,
				folderName: session.cwd ? path.basename(session.cwd) : undefined,
				pid: session.pid,
			},
			priority: 50,
			providerId: this.id,
			providerSessionId: session.providerSessionId,
			source: AGENT_SOURCE.EXTERNAL_TERMINAL,
			state: UNIFIED_AGENT_STATE.RUNNING,
			subagents: [],
			tools: [],
		};
	}
}

function isCodexProcess(commandLine: string, executable: string): boolean {
	const haystack = `${executable} ${commandLine}`.toLowerCase();
	return /(^|\s|\/)codex(\s|$)/.test(haystack);
}
