import type * as vscode from 'vscode';

export const AGENT_FRAMEWORK = {
	CLAUDE: 'claude',
	CODEX: 'codex',
} as const;

export type AgentFramework = (typeof AGENT_FRAMEWORK)[keyof typeof AGENT_FRAMEWORK];

export const AGENT_SOURCE = {
	VSCODE_TERMINAL: 'vscode-terminal',
	EXTERNAL_TERMINAL: 'external-terminal',
	TRANSCRIPT: 'transcript',
} as const;

export type AgentSource = (typeof AGENT_SOURCE)[keyof typeof AGENT_SOURCE];

export const UNIFIED_AGENT_STATE = {
	IDLE: 'idle',
	RUNNING: 'running',
	THINKING: 'thinking',
	READING: 'reading',
	WRITING: 'writing',
	WAITING_INPUT: 'waiting_input',
	DONE: 'done',
	UNKNOWN: 'unknown',
} as const;

export type UnifiedAgentState = (typeof UNIFIED_AGENT_STATE)[keyof typeof UNIFIED_AGENT_STATE];

export interface AgentCapabilities {
	focusable?: boolean;
	closable?: boolean;
}

export interface AgentToolSnapshot {
	toolId: string;
	status: string;
	done: boolean;
	permissionWait?: boolean;
}

export interface AgentSubagentSnapshot {
	parentToolId: string;
	label: string;
	tools: AgentToolSnapshot[];
	permissionWait?: boolean;
}

export interface AgentObservationMetadata {
	commandLine?: string;
	cwd?: string;
	folderName?: string;
	jsonlFile?: string;
	pid?: number;
	projectDir?: string;
	sessionId?: string;
	terminalName?: string;
	terminalRef?: vscode.Terminal;
}

export interface AgentObservation {
	capabilities?: AgentCapabilities;
	framework: AgentFramework;
	identityKeys: string[];
	metadata?: AgentObservationMetadata;
	preferredVisualId?: number;
	priority: number;
	providerId: string;
	providerSessionId: string;
	source: AgentSource;
	state: UnifiedAgentState;
	subagents: AgentSubagentSnapshot[];
	tools: AgentToolSnapshot[];
}

export interface AgentPresentation {
	capabilities: AgentCapabilities;
	folderName?: string;
	framework: AgentFramework;
	source: AgentSource;
	state: UnifiedAgentState;
	subagents: AgentSubagentSnapshot[];
	tools: AgentToolSnapshot[];
	visualId: number;
}

export interface ProcessSnapshot {
	commandLine: string;
	cwd?: string;
	elapsedSeconds: number;
	executable: string;
	pid: number;
	ppid: number;
}
