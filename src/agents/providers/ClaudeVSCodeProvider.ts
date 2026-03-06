import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getClaudeProjectDirPath, getSessionIdFromJsonlPath } from '../../claudePaths.js';
import {
	CLAUDE_JSONL_POLL_INTERVAL_MS,
	CLAUDE_PROJECT_SCAN_INTERVAL_MS,
	TERMINAL_NAME_PREFIX,
	WORKSPACE_KEY_AGENTS,
} from '../../constants.js';
import type { PixelAgentsLogger } from '../logger.js';
import type { AgentProvider } from '../provider.js';
import { AgentRegistry } from '../registry.js';
import { AGENT_FRAMEWORK, AGENT_SOURCE, UNIFIED_AGENT_STATE } from '../types.js';
import type { AgentObservation } from '../types.js';
import { ClaudeTranscriptWatcher } from '../claudeTranscriptWatcher.js';

interface PersistedVSCodeAgent {
	folderName?: string;
	id: number;
	jsonlFile: string;
	projectDir: string;
	providerSessionId?: string;
	sessionId?: string;
	terminalName: string;
}

interface ManagedSession {
	folderName?: string;
	jsonlFile: string;
	pollTimer: ReturnType<typeof setInterval> | null;
	preferredVisualId?: number;
	projectDir: string;
	providerSessionId: string;
	sessionId?: string;
	terminalRef: vscode.Terminal;
	transcriptSnapshot: {
		state: AgentObservation['state'];
		subagents: AgentObservation['subagents'];
		tools: AgentObservation['tools'];
	};
	transcriptWatcher: ClaudeTranscriptWatcher | null;
}

interface ProjectScanState {
	knownJsonlFiles: Set<string>;
	timer: ReturnType<typeof setInterval>;
}

export class ClaudeVSCodeProvider implements AgentProvider {
	readonly id = 'claude-vscode';

	private readonly disposables: vscode.Disposable[] = [];
	private readonly projectScans = new Map<string, ProjectScanState>();
	private readonly sessions = new Map<string, ManagedSession>();
	private readonly terminalToSessionId = new Map<vscode.Terminal, string>();
	private nextTerminalIndex = 1;
	private restored = false;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly registry: AgentRegistry,
		private readonly logger: PixelAgentsLogger,
	) {}

	start(): void {
		if (this.disposables.length > 0) {
			return;
		}

		this.ensureWorkspaceProjectScans();

		this.disposables.push(
			vscode.window.onDidChangeActiveTerminal((terminal) => {
				if (!terminal) {
					return;
				}
				const providerSessionId = this.terminalToSessionId.get(terminal);
				if (!providerSessionId) {
					return;
				}
				this.registry.selectObservation(this.id, providerSessionId);
			}),
			vscode.window.onDidCloseTerminal((terminal) => {
				const providerSessionId = this.terminalToSessionId.get(terminal);
				if (!providerSessionId) {
					return;
				}
				this.removeSession(providerSessionId, true);
			}),
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.ensureWorkspaceProjectScans();
			}),
		);
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;

		for (const sessionId of [...this.sessions.keys()]) {
			this.disposeSessionResources(sessionId);
		}
		for (const scan of this.projectScans.values()) {
			clearInterval(scan.timer);
		}
		this.projectScans.clear();
		this.sessions.clear();
		this.terminalToSessionId.clear();
	}

	restoreSessions(): void {
		if (this.restored) {
			return;
		}
		this.restored = true;

		const persisted = this.context.workspaceState.get<PersistedVSCodeAgent[]>(WORKSPACE_KEY_AGENTS, []);
		if (persisted.length === 0) {
			return;
		}

		const liveTerminals = vscode.window.terminals;
		let maxTerminalIndex = 0;

		for (const entry of persisted) {
			const terminal = liveTerminals.find((candidate) => candidate.name === entry.terminalName);
			if (!terminal) {
				continue;
			}

			const providerSessionId = entry.providerSessionId ?? entry.terminalName;
			const session: ManagedSession = {
				folderName: entry.folderName,
				jsonlFile: entry.jsonlFile,
				pollTimer: null,
				preferredVisualId: entry.id,
				projectDir: entry.projectDir,
				providerSessionId,
				sessionId: entry.sessionId ?? getSessionIdFromJsonlPath(entry.jsonlFile),
				terminalRef: terminal,
				transcriptSnapshot: {
					state: UNIFIED_AGENT_STATE.UNKNOWN,
					subagents: [],
					tools: [],
				},
				transcriptWatcher: null,
			};

			this.sessions.set(providerSessionId, session);
			this.terminalToSessionId.set(terminal, providerSessionId);
			this.ensureProjectScan(entry.projectDir);
			this.syncSession(session);
			this.startTranscriptTracking(session, true);

			const match = entry.terminalName.match(/#(\d+)$/);
			if (match) {
				maxTerminalIndex = Math.max(maxTerminalIndex, Number.parseInt(match[1], 10));
			}
		}

		if (maxTerminalIndex >= this.nextTerminalIndex) {
			this.nextTerminalIndex = maxTerminalIndex + 1;
		}

		this.persistSessions();
	}

	async launchAgent(folderPath?: string): Promise<void> {
		const folders = vscode.workspace.workspaceFolders;
		const cwd = folderPath || folders?.[0]?.uri.fsPath;
		const isMultiRoot = Boolean(folders && folders.length > 1);
		const folderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;
		const terminal = vscode.window.createTerminal({
			cwd,
			name: `${TERMINAL_NAME_PREFIX} #${this.nextTerminalIndex++}`,
		});
		terminal.show();

		const providerSessionId = randomUUID();
		const sessionId = randomUUID();
		terminal.sendText(`claude --session-id ${sessionId}`);

		const projectDir = getClaudeProjectDirPath(cwd) ?? '';
		const jsonlFile = projectDir ? path.join(projectDir, `${sessionId}.jsonl`) : '';
		const session: ManagedSession = {
			folderName,
			jsonlFile,
			pollTimer: null,
			projectDir,
			providerSessionId,
			sessionId,
			terminalRef: terminal,
			transcriptSnapshot: {
				state: UNIFIED_AGENT_STATE.RUNNING,
				subagents: [],
				tools: [],
			},
			transcriptWatcher: null,
		};

		this.sessions.set(providerSessionId, session);
		this.terminalToSessionId.set(terminal, providerSessionId);
		this.syncSession(session);

		if (projectDir) {
			this.ensureProjectScan(projectDir);
			this.startTranscriptTracking(session, false);
		}

		this.persistSessions();
		this.logger.debug('Launched VS Code Claude session', { jsonlFile, providerSessionId, sessionId, terminalName: terminal.name });
	}

	focusSession(providerSessionId: string): void {
		this.sessions.get(providerSessionId)?.terminalRef.show();
	}

	closeSession(providerSessionId: string): void {
		this.sessions.get(providerSessionId)?.terminalRef.dispose();
	}

	private ensureWorkspaceProjectScans(): void {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const projectDir = getClaudeProjectDirPath(folder.uri.fsPath);
			if (projectDir) {
				this.ensureProjectScan(projectDir);
			}
		}
	}

	private ensureProjectScan(projectDir: string): void {
		if (!projectDir || this.projectScans.has(projectDir)) {
			return;
		}

		const knownJsonlFiles = new Set<string>();
		for (const filePath of readJsonlFiles(projectDir)) {
			knownJsonlFiles.add(filePath);
		}

		const timer = setInterval(() => {
			this.scanProjectDir(projectDir);
		}, CLAUDE_PROJECT_SCAN_INTERVAL_MS);

		this.projectScans.set(projectDir, {
			knownJsonlFiles,
			timer,
		});
	}

	private scanProjectDir(projectDir: string): void {
		const scanState = this.projectScans.get(projectDir);
		if (!scanState) {
			return;
		}

		for (const filePath of readJsonlFiles(projectDir)) {
			if (scanState.knownJsonlFiles.has(filePath)) {
				continue;
			}

			scanState.knownJsonlFiles.add(filePath);
			this.logger.debug('Detected new Claude transcript file', { filePath, projectDir });

			const activeTerminal = vscode.window.activeTerminal;
			const activeSessionId = activeTerminal ? this.terminalToSessionId.get(activeTerminal) : undefined;
			const activeSession = activeSessionId ? this.sessions.get(activeSessionId) : undefined;
			if (activeSession && activeSession.projectDir === projectDir) {
				this.reassignSessionToFile(activeSession, filePath);
				continue;
			}

			if (!activeTerminal || this.terminalToSessionId.has(activeTerminal)) {
				continue;
			}

			this.adoptTerminal(activeTerminal, filePath, projectDir);
		}
	}

	private adoptTerminal(terminal: vscode.Terminal, jsonlFile: string, projectDir: string): void {
		const providerSessionId = randomUUID();
		const session: ManagedSession = {
			jsonlFile,
			pollTimer: null,
			projectDir,
			providerSessionId,
			sessionId: getSessionIdFromJsonlPath(jsonlFile),
			terminalRef: terminal,
			transcriptSnapshot: {
				state: UNIFIED_AGENT_STATE.UNKNOWN,
				subagents: [],
				tools: [],
			},
			transcriptWatcher: null,
		};

		this.sessions.set(providerSessionId, session);
		this.terminalToSessionId.set(terminal, providerSessionId);
		this.syncSession(session);
		this.startTranscriptTracking(session, false);
		this.persistSessions();
		this.logger.debug('Adopted VS Code terminal for Claude transcript', { providerSessionId, terminalName: terminal.name, jsonlFile });
	}

	private reassignSessionToFile(session: ManagedSession, jsonlFile: string): void {
		this.disposeTranscriptTracking(session);
		session.jsonlFile = jsonlFile;
		session.sessionId = getSessionIdFromJsonlPath(jsonlFile);
		session.transcriptSnapshot = {
			state: UNIFIED_AGENT_STATE.RUNNING,
			subagents: [],
			tools: [],
		};
		this.startTranscriptTracking(session, false);
		this.syncSession(session);
		this.persistSessions();
		this.logger.debug('Reassigned Claude session to new transcript file', {
			jsonlFile,
			providerSessionId: session.providerSessionId,
			terminalName: session.terminalRef.name,
		});
	}

	private startTranscriptTracking(session: ManagedSession, readFromEnd: boolean): void {
		if (!session.jsonlFile) {
			return;
		}

		this.disposeTranscriptTracking(session);
		if (fs.existsSync(session.jsonlFile)) {
			this.createWatcher(session, readFromEnd);
			return;
		}

		session.pollTimer = setInterval(() => {
			if (!fs.existsSync(session.jsonlFile)) {
				return;
			}
			if (session.pollTimer) {
				clearInterval(session.pollTimer);
				session.pollTimer = null;
			}
			this.createWatcher(session, readFromEnd);
		}, CLAUDE_JSONL_POLL_INTERVAL_MS);
	}

	private createWatcher(session: ManagedSession, readFromEnd: boolean): void {
		session.transcriptWatcher = new ClaudeTranscriptWatcher({
			filePath: session.jsonlFile,
			logger: this.logger,
			onUpdate: (snapshot) => {
				session.transcriptSnapshot = snapshot;
				this.syncSession(session);
			},
			readFromEnd,
			watcherId: session.providerSessionId,
		});
		session.transcriptWatcher.start();
	}

	private disposeTranscriptTracking(session: ManagedSession): void {
		if (session.pollTimer) {
			clearInterval(session.pollTimer);
			session.pollTimer = null;
		}
		session.transcriptWatcher?.dispose();
		session.transcriptWatcher = null;
	}

	private syncSession(session: ManagedSession): void {
		this.registry.upsertObservation(this.toObservation(session));
		const visualId = this.registry.getVisualIdForObservation(this.id, session.providerSessionId);
		if (visualId !== undefined) {
			session.preferredVisualId = visualId;
		}
	}

	private toObservation(session: ManagedSession): AgentObservation {
		return {
			capabilities: {
				closable: true,
				focusable: true,
			},
			framework: AGENT_FRAMEWORK.CLAUDE,
			identityKeys: [
				session.sessionId ? `claude-session:${session.sessionId}` : '',
				session.jsonlFile ? `claude-transcript:${session.jsonlFile}` : '',
				`vscode-terminal:${session.providerSessionId}`,
			].filter(Boolean),
			metadata: {
				folderName: session.folderName,
				jsonlFile: session.jsonlFile || undefined,
				projectDir: session.projectDir || undefined,
				sessionId: session.sessionId,
				terminalName: session.terminalRef.name,
				terminalRef: session.terminalRef,
			},
			preferredVisualId: session.preferredVisualId,
			priority: 100,
			providerId: this.id,
			providerSessionId: session.providerSessionId,
			source: AGENT_SOURCE.VSCODE_TERMINAL,
			state: session.transcriptSnapshot.state,
			subagents: session.transcriptSnapshot.subagents,
			tools: session.transcriptSnapshot.tools,
		};
	}

	private removeSession(providerSessionId: string, immediate: boolean): void {
		this.disposeSessionResources(providerSessionId);
		this.registry.removeObservation(this.id, providerSessionId, immediate);
		this.persistSessions();
	}

	private disposeSessionResources(providerSessionId: string): void {
		const session = this.sessions.get(providerSessionId);
		if (!session) {
			return;
		}

		this.disposeTranscriptTracking(session);
		this.terminalToSessionId.delete(session.terminalRef);
		this.sessions.delete(providerSessionId);
	}

	private persistSessions(): void {
		const persisted: PersistedVSCodeAgent[] = [];
		for (const session of this.sessions.values()) {
			const id = session.preferredVisualId ?? this.registry.getVisualIdForObservation(this.id, session.providerSessionId);
			if (id === undefined) {
				continue;
			}
			persisted.push({
				folderName: session.folderName,
				id,
				jsonlFile: session.jsonlFile,
				projectDir: session.projectDir,
				providerSessionId: session.providerSessionId,
				sessionId: session.sessionId,
				terminalName: session.terminalRef.name,
			});
		}
		this.context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
	}
}

function readJsonlFiles(projectDir: string): string[] {
	try {
		return fs.readdirSync(projectDir)
			.filter((fileName) => fileName.endsWith('.jsonl'))
			.map((fileName) => path.join(projectDir, fileName));
	} catch {
		return [];
	}
}

