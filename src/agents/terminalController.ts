import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ProcessSnapshot } from './types.js';
import { findTerminalAncestorProcess } from './terminalProcessUtils.js';

const execFileAsync = promisify(execFile);

export class TerminalController {
	constructor(private readonly processProvider: () => Promise<ProcessSnapshot[]>) {}

	async focusProcess(pid: number): Promise<void> {
		const processes = await this.processProvider();
		const appProcess = findTerminalAncestorProcess(processes, pid);
		if (!appProcess) {
			return;
		}

		await execFileAsync('osascript', [
			'-e',
			`tell application "System Events" to set frontmost of first application process whose unix id is ${appProcess.pid} to true`,
		]);
	}

	terminateProcess(pid: number): void {
		try {
			process.kill(pid, 'SIGTERM');
		} catch {
			// Ignore termination failures.
		}
	}

	async launchClaude(cwd?: string): Promise<void> {
		await this.launchInTerminal(`cd ${shellQuote(cwd || process.env.HOME || '~')} && claude`);
	}

	async launchCodex(cwd?: string): Promise<void> {
		await this.launchInTerminal(`cd ${shellQuote(cwd || process.env.HOME || '~')} && codex`);
	}

	async launchShell(cwd?: string): Promise<void> {
		await this.launchInTerminal(`cd ${shellQuote(cwd || process.env.HOME || '~')}`);
	}

	private async launchInTerminal(command: string): Promise<void> {
		await execFileAsync('osascript', [
			'-e',
			'tell application "Terminal"',
			'-e',
			'activate',
			'-e',
			`do script "${escapeAppleScriptString(command)}"`,
			'-e',
			'end tell',
		]);
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeAppleScriptString(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
