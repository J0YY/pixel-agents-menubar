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
			const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,etimes=,comm=,command=']);
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

		const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
		if (!match) {
			continue;
		}

		processes.push({
			commandLine: match[5],
			elapsedSeconds: Number.parseInt(match[3], 10),
			executable: match[4],
			pid: Number.parseInt(match[1], 10),
			ppid: Number.parseInt(match[2], 10),
		});
	}

	return processes;
}

