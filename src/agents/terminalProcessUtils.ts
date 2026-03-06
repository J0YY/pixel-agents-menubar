import type { ProcessSnapshot } from './types.js';

const TERMINAL_APP_PATTERNS: Array<{ appName: string; fragments: string[] }> = [
	{ appName: 'Terminal', fragments: ['terminal.app'] },
	{ appName: 'iTerm', fragments: ['iterm'] },
	{ appName: 'Warp', fragments: ['warp'] },
	{ appName: 'WezTerm', fragments: ['wezterm'] },
	{ appName: 'Alacritty', fragments: ['alacritty'] },
	{ appName: 'Kitty', fragments: ['kitty'] },
	{ appName: 'Ghostty', fragments: ['ghostty'] },
];

const SHELL_EXECUTABLES = new Set([
	'bash',
	'dash',
	'fish',
	'nu',
	'screen',
	'sh',
	'tcsh',
	'tmux',
	'xonsh',
	'zsh',
]);

const AGENT_EXECUTABLES = new Set([
	'claude',
	'claude-code',
	'codex',
]);

export type TerminalSessionKind = 'agent' | 'shell';

export interface TerminalSessionSnapshot {
	commandLine: string;
	elapsedSeconds: number;
	executable: string;
	id: string;
	kind: TerminalSessionKind;
	pid: number;
	terminalApp: string;
}

export function findTerminalAncestorProcess(
	processes: ProcessSnapshot[],
	pid: number,
): ProcessSnapshot | undefined {
	const byPid = new Map(processes.map((processSnapshot) => [processSnapshot.pid, processSnapshot]));
	let current = byPid.get(pid);
	const seen = new Set<number>();

	while (current && !seen.has(current.pid)) {
		seen.add(current.pid);
		if (isTerminalAppProcess(current)) {
			return current;
		}
		current = byPid.get(current.ppid);
	}

	return undefined;
}

export function getTerminalAppName(processSnapshot: ProcessSnapshot): string | undefined {
	const haystack = `${processSnapshot.executable} ${processSnapshot.commandLine}`.toLowerCase();
	const match = TERMINAL_APP_PATTERNS.find((pattern) =>
		pattern.fragments.some((fragment) => haystack.includes(fragment)),
	);
	return match?.appName;
}

export function isTerminalAppProcess(processSnapshot: ProcessSnapshot): boolean {
	return Boolean(getTerminalAppName(processSnapshot));
}

export function listTerminalSessions(processes: ProcessSnapshot[]): TerminalSessionSnapshot[] {
	const byPid = new Map(processes.map((processSnapshot) => [processSnapshot.pid, processSnapshot]));
	const childrenByPid = new Map<number, ProcessSnapshot[]>();

	for (const processSnapshot of processes) {
		const siblings = childrenByPid.get(processSnapshot.ppid) ?? [];
		siblings.push(processSnapshot);
		childrenByPid.set(processSnapshot.ppid, siblings);
	}

	const candidates = new Map<number, TerminalSessionSnapshot>();
	for (const processSnapshot of processes) {
		const kind = classifyTerminalSessionKind(processSnapshot);
		if (!kind) {
			continue;
		}

		const ancestor = findTerminalAncestorProcess(processes, processSnapshot.pid);
		if (!ancestor) {
			continue;
		}

		candidates.set(processSnapshot.pid, {
			commandLine: processSnapshot.commandLine,
			elapsedSeconds: processSnapshot.elapsedSeconds,
			executable: getDisplayProcessName(processSnapshot),
			id: `pid:${processSnapshot.pid}`,
			kind,
			pid: processSnapshot.pid,
			terminalApp: getTerminalAppName(ancestor) ?? 'Terminal',
		});
	}

	const sessions = [...candidates.values()].filter((candidate) => {
		return !hasCandidateDescendant(candidate.pid, childrenByPid, candidates);
	});

	sessions.sort((left, right) => {
		if (left.terminalApp !== right.terminalApp) {
			return left.terminalApp.localeCompare(right.terminalApp);
		}
		if (left.kind !== right.kind) {
			return left.kind === 'agent' ? -1 : 1;
		}
		return left.pid - right.pid;
	});

	return sessions;
}

function classifyTerminalSessionKind(processSnapshot: ProcessSnapshot): TerminalSessionKind | undefined {
	if (isAgentProcess(processSnapshot)) {
		return 'agent';
	}

	if (isShellProcess(processSnapshot)) {
		return 'shell';
	}

	return undefined;
}

function hasCandidateDescendant(
	pid: number,
	childrenByPid: Map<number, ProcessSnapshot[]>,
	candidates: Map<number, TerminalSessionSnapshot>,
): boolean {
	const stack = [...(childrenByPid.get(pid) ?? [])];
	const seen = new Set<number>();

	while (stack.length > 0) {
		const child = stack.pop();
		if (!child || seen.has(child.pid)) {
			continue;
		}

		seen.add(child.pid);
		if (candidates.has(child.pid)) {
			return true;
		}

		stack.push(...(childrenByPid.get(child.pid) ?? []));
	}

	return false;
}

function isAgentProcess(processSnapshot: ProcessSnapshot): boolean {
	const baseName = getProcessBaseName(processSnapshot.executable);
	if (AGENT_EXECUTABLES.has(baseName)) {
		return true;
	}

	const haystack = `${processSnapshot.executable} ${processSnapshot.commandLine}`.toLowerCase();
	return /(^|\s|\/)(claude|claude-code|codex)(\s|$)/.test(haystack);
}

function isShellProcess(processSnapshot: ProcessSnapshot): boolean {
	return SHELL_EXECUTABLES.has(getProcessBaseName(processSnapshot.executable));
}

function getProcessBaseName(executable: string): string {
	const normalized = executable.split('/').pop() ?? executable;
	return normalized
		.toLowerCase()
		.replace(/^[^a-z0-9]+/, '')
		.replace(/[^a-z0-9]+$/, '');
}

function getDisplayProcessName(processSnapshot: ProcessSnapshot): string {
	const executableName = getProcessBaseName(processSnapshot.executable);
	if (executableName) {
		return executableName;
	}

	const commandBase = processSnapshot.commandLine.trim().split(/\s+/)[0] ?? '';
	return getProcessBaseName(commandBase);
}
