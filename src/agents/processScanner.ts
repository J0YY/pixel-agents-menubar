import { execFile } from 'child_process';
import { promisify } from 'util';
import { PROCESS_SCANNER_CACHE_TTL_MS } from '../constants.js';
import type { ProcessSnapshot } from './types.js';
import type { PixelAgentsLogger } from './logger.js';

const execFileAsync = promisify(execFile);

export class ProcessScanner {
	private cachedAt = 0;
	private cachedProcesses: ProcessSnapshot[] = [];

	constructor(private readonly logger: PixelAgentsLogger) {}

	async scan(): Promise<ProcessSnapshot[]> {
		if (process.platform !== 'darwin') {
			return [];
		}

		const now = Date.now();
		if (now - this.cachedAt <= PROCESS_SCANNER_CACHE_TTL_MS) {
			return this.cachedProcesses;
		}

		try {
			const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,etime=,comm=,command=']);
			const processes = parsePsOutput(stdout);
			await attachWorkingDirectories(processes, this.logger);
			this.cachedProcesses = processes;
			this.cachedAt = now;
			return processes;
		} catch (error) {
			this.logger.warn('External process scan failed', error);
			return this.cachedProcesses;
		}
	}
}

function parsePsOutput(stdout: string): ProcessSnapshot[] {
	const lines = stdout.split('\n');
	const processes: ProcessSnapshot[] = [];

	for (const line of lines) {
		if (!line.trim()) {
			continue;
		}

		const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
		if (!match) {
			continue;
		}

		const elapsedSeconds = parseElapsedTime(match[3]);
		if (elapsedSeconds === null) {
			continue;
		}

		processes.push({
			commandLine: match[5],
			elapsedSeconds,
			executable: match[4],
			pid: Number.parseInt(match[1], 10),
			ppid: Number.parseInt(match[2], 10),
		});
	}

	return processes;
}

async function attachWorkingDirectories(
	processes: ProcessSnapshot[],
	logger: PixelAgentsLogger,
): Promise<void> {
	const candidatePids = processes
		.filter((processSnapshot) => shouldResolveCwd(processSnapshot))
		.map((processSnapshot) => processSnapshot.pid);

	if (candidatePids.length === 0) {
		return;
	}

	try {
		const cwdByPid = await resolveCwdByPid(candidatePids);
		for (const processSnapshot of processes) {
			processSnapshot.cwd = cwdByPid.get(processSnapshot.pid);
		}
	} catch (error) {
		logger.warn('Working directory scan failed', error);
	}
}

async function resolveCwdByPid(pids: number[]): Promise<Map<number, string>> {
	let stdout = '';
	try {
		({ stdout } = await execFileAsync('lsof', ['-a', '-d', 'cwd', '-Fn', ...pids.flatMap((pid) => ['-p', String(pid)])]));
	} catch (error) {
		const partialStdout = (error as { stdout?: string }).stdout;
		if (typeof partialStdout !== 'string' || partialStdout.length === 0) {
			throw error;
		}
		stdout = partialStdout;
	}
	const cwdByPid = new Map<number, string>();
	let currentPid: number | null = null;

	for (const line of stdout.split('\n')) {
		if (!line) {
			continue;
		}

		const prefix = line[0];
		const value = line.slice(1);
		if (prefix === 'p') {
			const pid = Number.parseInt(value, 10);
			currentPid = Number.isFinite(pid) ? pid : null;
			continue;
		}

		if (prefix === 'n' && currentPid !== null) {
			cwdByPid.set(currentPid, value);
		}
	}

	return cwdByPid;
}

function shouldResolveCwd(processSnapshot: ProcessSnapshot): boolean {
	const haystack = `${processSnapshot.executable} ${processSnapshot.commandLine}`.toLowerCase();
	return /(^|\s|\/)(bash|dash|fish|nu|screen|sh|tcsh|tmux|xonsh|zsh|claude|claude-code|codex)(\s|$)/.test(haystack);
}

function parseElapsedTime(rawValue: string): number | null {
	const trimmed = rawValue.trim();
	const daySplit = trimmed.split('-');
	const timePart = daySplit[daySplit.length - 1];
	const dayCount = daySplit.length === 2 ? Number.parseInt(daySplit[0], 10) : 0;
	if (!Number.isFinite(dayCount)) {
		return null;
	}

	const segments = timePart.split(':').map((segment) => Number.parseInt(segment, 10));
	if (segments.some((segment) => !Number.isFinite(segment))) {
		return null;
	}

	let hours = 0;
	let minutes = 0;
	let seconds = 0;

	if (segments.length === 3) {
		[hours, minutes, seconds] = segments;
	} else if (segments.length === 2) {
		[minutes, seconds] = segments;
	} else if (segments.length === 1) {
		[seconds] = segments;
	} else {
		return null;
	}

	return (((dayCount * 24) + hours) * 60 + minutes) * 60 + seconds;
}
