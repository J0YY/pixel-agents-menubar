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
