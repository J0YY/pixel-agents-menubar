import type { PixelAgentsLogger } from '../agents/logger.js';
import { ProcessScanner } from '../agents/processScanner.js';
import { TerminalController } from '../agents/terminalController.js';
import { listTerminalSessions } from '../agents/terminalProcessUtils.js';

interface TerminalSessionDto {
	commandLine: string;
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
	private latestSessions: TerminalSessionDto[] = [];
	private messageTarget: { postMessage: (message: unknown) => void } | undefined;
	private scanTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
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

	private async scanNow(): Promise<void> {
		const processes = await this.scanner.scan();
		const sessions = listTerminalSessions(processes).map((session) => ({
			commandLine: session.commandLine,
			detail: buildSessionDetail(session.commandLine),
			id: session.id,
			kind: session.kind,
			label: buildSessionLabel(session.kind, session.executable),
			pid: session.pid,
			runningFor: formatElapsedSeconds(session.elapsedSeconds),
			terminalApp: session.terminalApp,
		}));

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
}

function buildSessionDetail(commandLine: string): string {
	const compact = commandLine.replace(/\s+/g, ' ').trim();
	if (compact.length <= 88) {
		return compact;
	}
	return `${compact.slice(0, 85)}...`;
}

function buildSessionLabel(kind: 'agent' | 'shell', executable: string): string {
	const display = executable
		.split(/[-_]/)
		.filter(Boolean)
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join(' ');
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
