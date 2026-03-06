import * as path from 'path';
import type { PixelAgentsLogger } from '../agents/logger.js';
import { ProcessScanner } from '../agents/processScanner.js';
import { TerminalController } from '../agents/terminalController.js';
import { listTerminalSessions } from '../agents/terminalProcessUtils.js';
import { DesktopStateStore } from './stateStore.js';

interface TerminalSessionDto {
	commandLine: string;
	cwd?: string;
	defaultLabel: string;
	detail: string;
	id: string;
	kind: 'agent' | 'shell';
	label: string;
	pid: number;
	runningFor: string;
	terminalApp: string;
}

export class TerminalSessionService {
	private lastPayloadSignature = '';
	private latestSessionSnapshots: ReturnType<typeof listTerminalSessions> = [];
	private latestSessions: TerminalSessionDto[] = [];
	private messageTarget: { postMessage: (message: unknown) => void } | undefined;
	private scanTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly stateStore: DesktopStateStore,
		private readonly scanner: ProcessScanner,
		private readonly terminalController: TerminalController,
		private readonly logger: PixelAgentsLogger,
		private readonly scanIntervalMs: number,
	) {}

	start(): void {
		if (process.platform !== 'darwin' || this.scanTimer) {
			return;
		}

		void this.scanNow();
		this.scanTimer = setInterval(() => {
			void this.scanNow();
		}, this.scanIntervalMs);
	}

	dispose(): void {
		if (this.scanTimer) {
			clearInterval(this.scanTimer);
			this.scanTimer = null;
		}
		this.latestSessionSnapshots = [];
		this.latestSessions = [];
		this.lastPayloadSignature = '';
		this.messageTarget = undefined;
	}

	setMessageTarget(messageTarget: { postMessage: (message: unknown) => void } | undefined): void {
		this.messageTarget = messageTarget;
		this.sendSessions();
	}

	async focusSession(sessionId: string): Promise<void> {
		const pid = parseSessionPid(sessionId);
		if (!pid) {
			return;
		}
		await this.terminalController.focusProcess(pid);
	}

	terminateSession(sessionId: string): void {
		const pid = parseSessionPid(sessionId);
		if (!pid) {
			return;
		}
		this.terminalController.terminateProcess(pid);
	}

	async launchShell(folderPath?: string): Promise<void> {
		await this.terminalController.launchShell(folderPath);
	}

	renameSession(sessionId: string, label: string | undefined): void {
		this.stateStore.setTerminalLabelOverride(sessionId, normalizeTerminalLabel(label));
		this.rebuildSessionDtos();
	}

	private async scanNow(): Promise<void> {
		const processes = await this.scanner.scan();
		this.latestSessionSnapshots = listTerminalSessions(processes);
		const sessions = this.buildSessionDtos(this.latestSessionSnapshots);

		const payloadSignature = JSON.stringify(sessions);
		if (payloadSignature === this.lastPayloadSignature) {
			return;
		}

		this.latestSessions = sessions;
		this.lastPayloadSignature = payloadSignature;
		this.logger.debug('Updated desktop terminal session inventory', {
			count: sessions.length,
		});
		this.sendSessions();
	}

	private sendSessions(): void {
		if (!this.messageTarget) {
			return;
		}
		this.messageTarget.postMessage({
			type: 'terminalSessionsUpdated',
			sessions: this.latestSessions,
		});
	}

	private rebuildSessionDtos(): void {
		this.latestSessions = this.buildSessionDtos(this.latestSessionSnapshots);
		this.lastPayloadSignature = JSON.stringify(this.latestSessions);
		this.sendSessions();
	}

	private buildSessionDtos(snapshots: ReturnType<typeof listTerminalSessions>): TerminalSessionDto[] {
		const labelOverrides = this.stateStore.getTerminalLabelOverrides();
		return snapshots.map((session) => {
			const defaultLabel = buildSessionDefaultLabel(session.kind, session.executable, session.cwd);
			return {
				commandLine: session.commandLine,
				cwd: session.cwd,
				defaultLabel,
				detail: buildSessionDetail(session.commandLine),
				id: session.id,
				kind: session.kind,
				label: labelOverrides[session.id] ?? defaultLabel,
				pid: session.pid,
				runningFor: formatElapsedSeconds(session.elapsedSeconds),
				terminalApp: session.terminalApp,
			};
		});
	}
}

function buildSessionDetail(commandLine: string): string {
	const compact = commandLine.replace(/\s+/g, ' ').trim();
	if (compact.length <= 88) {
		return compact;
	}
	return `${compact.slice(0, 85)}...`;
}

function buildSessionDefaultLabel(kind: 'agent' | 'shell', executable: string, cwd?: string): string {
	if (cwd) {
		const folderName = path.basename(cwd);
		if (folderName && folderName !== path.sep) {
			return folderName;
		}
	}

	const display = executable
		.split(/[-_]/)
		.filter(Boolean)
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join(' ');
	if (!display) {
		return kind === 'agent' ? 'Agent session' : 'Shell session';
	}
	return kind === 'agent' ? display : `${display} shell`;
}

function formatElapsedSeconds(elapsedSeconds: number): string {
	if (elapsedSeconds < 60) {
		return `${elapsedSeconds}s`;
	}

	const totalMinutes = Math.floor(elapsedSeconds / 60);
	if (totalMinutes < 60) {
		return `${totalMinutes}m`;
	}

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function parseSessionPid(sessionId: string): number | undefined {
	const match = sessionId.match(/^pid:(\d+)$/);
	if (!match) {
		return undefined;
	}
	const pid = Number.parseInt(match[1], 10);
	return Number.isFinite(pid) ? pid : undefined;
}

function normalizeTerminalLabel(label: string | undefined): string | undefined {
	const trimmed = label?.trim();
	return trimmed ? trimmed : undefined;
}
