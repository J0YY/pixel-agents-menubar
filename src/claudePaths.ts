import * as os from 'os';
import * as path from 'path';

export function getClaudeProjectDirPath(workspacePath?: string): string | null {
	if (!workspacePath) {
		return null;
	}

	const dirName = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
	return path.join(os.homedir(), '.claude', 'projects', dirName);
}

export function getClaudeProjectsRoot(): string {
	return path.join(os.homedir(), '.claude', 'projects');
}

export function getSessionIdFromJsonlPath(jsonlFile: string): string | undefined {
	const basename = path.basename(jsonlFile, '.jsonl');
	return basename || undefined;
}
