import * as fs from 'fs';
import * as path from 'path';
import {
	BASH_COMMAND_DISPLAY_MAX_LENGTH,
	CLAUDE_FILE_WATCHER_POLL_INTERVAL_MS,
	CLAUDE_PERMISSION_TIMER_DELAY_MS,
	CLAUDE_TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
	CLAUDE_TEXT_IDLE_DELAY_MS,
} from '../constants.js';
import type { PixelAgentsLogger } from './logger.js';
import type { AgentSubagentSnapshot, AgentToolSnapshot, UnifiedAgentState } from './types.js';
import { UNIFIED_AGENT_STATE } from './types.js';

const PERMISSION_EXEMPT_TOOLS = new Set(['AskUserQuestion', 'Task']);
const READING_TOOLS = new Set(['Grep', 'Glob', 'Read', 'WebFetch', 'WebSearch']);
const WRITING_TOOLS = new Set(['Edit', 'NotebookEdit', 'Write']);

interface ToolState extends AgentToolSnapshot {
	name: string;
}

interface SubagentState {
	label: string;
	parentToolId: string;
	tools: Map<string, ToolState>;
}

export interface ClaudeTranscriptSnapshot {
	state: UnifiedAgentState;
	subagents: AgentSubagentSnapshot[];
	tools: AgentToolSnapshot[];
}

interface ClaudeTranscriptWatcherOptions {
	filePath: string;
	logger: PixelAgentsLogger;
	onUpdate: (snapshot: ClaudeTranscriptSnapshot) => void;
	readFromEnd?: boolean;
	watcherId: string;
}

export class ClaudeTranscriptWatcher {
	private readonly filePath: string;
	private readonly logger: PixelAgentsLogger;
	private readonly onUpdate: (snapshot: ClaudeTranscriptSnapshot) => void;
	private readonly readFromEnd: boolean;
	private readonly watcherId: string;

	private currentState: UnifiedAgentState = UNIFIED_AGENT_STATE.UNKNOWN;
	private fileOffset = 0;
	private fsWatcher: fs.FSWatcher | undefined;
	private hadToolsInTurn = false;
	private isWaiting = false;
	private lineBuffer = '';
	private permissionSent = false;
	private permissionTimer: ReturnType<typeof setTimeout> | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private tools = new Map<string, ToolState>();
	private subagents = new Map<string, SubagentState>();
	private waitingTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(options: ClaudeTranscriptWatcherOptions) {
		this.filePath = options.filePath;
		this.logger = options.logger;
		this.onUpdate = options.onUpdate;
		this.readFromEnd = options.readFromEnd ?? false;
		this.watcherId = options.watcherId;
	}

	start(): void {
		try {
			if (this.readFromEnd && fs.existsSync(this.filePath)) {
				this.fileOffset = fs.statSync(this.filePath).size;
			}
		} catch {
			this.fileOffset = 0;
		}

		try {
			this.fsWatcher = fs.watch(this.filePath, () => {
				this.readNewLines();
			});
		} catch (error) {
			this.logger.debug(`Transcript fs.watch failed for ${this.watcherId}`, error);
		}

		try {
			fs.watchFile(this.filePath, { interval: CLAUDE_FILE_WATCHER_POLL_INTERVAL_MS }, () => {
				this.readNewLines();
			});
		} catch (error) {
			this.logger.debug(`Transcript fs.watchFile failed for ${this.watcherId}`, error);
		}

		this.pollTimer = setInterval(() => {
			this.readNewLines();
		}, CLAUDE_FILE_WATCHER_POLL_INTERVAL_MS);

		this.emit();
	}

	dispose(): void {
		this.fsWatcher?.close();
		this.fsWatcher = undefined;

		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}

		try {
			fs.unwatchFile(this.filePath);
		} catch {
			// Ignore cleanup failures.
		}

		this.cancelPermissionTimer();
		this.cancelWaitingTimer();
	}

	getSnapshot(): ClaudeTranscriptSnapshot {
		return {
			state: this.currentState,
			subagents: Array.from(this.subagents.values()).map((subagent) => ({
				label: subagent.label,
				parentToolId: subagent.parentToolId,
				permissionWait: Array.from(subagent.tools.values()).some((tool) => tool.permissionWait && !tool.done),
				tools: Array.from(subagent.tools.values()).map(stripToolName),
			})),
			tools: Array.from(this.tools.values()).map(stripToolName),
		};
	}

	private emit(): void {
		this.onUpdate(this.getSnapshot());
	}

	private readNewLines(): void {
		try {
			const stat = fs.statSync(this.filePath);
			if (stat.size <= this.fileOffset) {
				return;
			}

			const nextChunk = Buffer.alloc(stat.size - this.fileOffset);
			const fd = fs.openSync(this.filePath, 'r');
			fs.readSync(fd, nextChunk, 0, nextChunk.length, this.fileOffset);
			fs.closeSync(fd);
			this.fileOffset = stat.size;

			const text = this.lineBuffer + nextChunk.toString('utf-8');
			const lines = text.split('\n');
			this.lineBuffer = lines.pop() || '';

			const hasLines = lines.some((line) => line.trim().length > 0);
			if (hasLines) {
				this.cancelWaitingTimer();
				this.clearPermissionWaitFlags();
				if (this.isWaiting) {
					this.isWaiting = false;
				}
			}

			let changed = false;
			for (const line of lines) {
				if (!line.trim()) {
					continue;
				}
				changed = this.processTranscriptLine(line) || changed;
			}

			if (changed) {
				this.emit();
			}
		} catch (error) {
			this.logger.debug(`Transcript read failed for ${this.watcherId}`, error);
		}
	}

	private processTranscriptLine(line: string): boolean {
		try {
			const record = JSON.parse(line) as Record<string, unknown>;

			if (record.type === 'assistant' && Array.isArray((record.message as { content?: unknown })?.content)) {
				return this.handleAssistantRecord(record);
			}

			if (record.type === 'progress') {
				return this.handleProgressRecord(record);
			}

			if (record.type === 'user') {
				return this.handleUserRecord(record);
			}

			if (record.type === 'system' && record.subtype === 'turn_duration') {
				this.cancelWaitingTimer();
				this.cancelPermissionTimer();
				this.tools.clear();
				this.subagents.clear();
				this.hadToolsInTurn = false;
				this.isWaiting = true;
				this.currentState = UNIFIED_AGENT_STATE.WAITING_INPUT;
				this.permissionSent = false;
				return true;
			}
		} catch {
			// Ignore malformed transcript lines.
		}

		return false;
	}

	private handleAssistantRecord(record: Record<string, unknown>): boolean {
		const blocks = ((record.message as { content?: unknown[] })?.content ?? []) as Array<{
			id?: string;
			input?: Record<string, unknown>;
			name?: string;
			type?: string;
		}>;
		const toolBlocks = blocks.filter((block) => block.type === 'tool_use' && block.id);

		if (toolBlocks.length > 0) {
			this.cancelWaitingTimer();
			this.isWaiting = false;
			this.hadToolsInTurn = true;

			let hasNonExemptTool = false;
			const nextState = pickDominantState(toolBlocks.map((block) => block.name || ''));
			this.currentState = nextState;

			for (const block of toolBlocks) {
				const toolId = block.id as string;
				const toolName = block.name || '';
				const status = formatToolStatus(toolName, block.input || {});
				const existing = this.tools.get(toolId);
				this.tools.set(toolId, {
					done: false,
					name: toolName,
					permissionWait: false,
					status,
					toolId,
				});
				void existing;
				if (toolName === 'Task') {
					this.subagents.set(toolId, {
						label: status.startsWith('Subtask:') ? status.slice('Subtask:'.length).trim() : 'Subtask',
						parentToolId: toolId,
						tools: this.subagents.get(toolId)?.tools ?? new Map<string, ToolState>(),
					});
				}
				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					hasNonExemptTool = true;
				}
			}

			if (hasNonExemptTool) {
				this.startPermissionTimer();
			}
			return true;
		}

		const hasText = blocks.some((block) => block.type === 'text');
		if (hasText && !this.hadToolsInTurn) {
			this.currentState = UNIFIED_AGENT_STATE.THINKING;
			this.startWaitingTimer(CLAUDE_TEXT_IDLE_DELAY_MS);
			return true;
		}

		return false;
	}

	private handleUserRecord(record: Record<string, unknown>): boolean {
		const content = (record.message as { content?: unknown })?.content;
		if (Array.isArray(content)) {
			const blocks = content as Array<{ tool_use_id?: string; type?: string }>;
			const toolResults = blocks.filter((block) => block.type === 'tool_result' && block.tool_use_id);
			if (toolResults.length > 0) {
				for (const block of toolResults) {
					this.markToolDone(block.tool_use_id as string);
				}
				if (Array.from(this.tools.values()).every((tool) => tool.done)) {
					this.hadToolsInTurn = false;
				}
				return true;
			}

			if (blocks.length > 0) {
				this.beginNewTurn();
				return true;
			}
		}

		if (typeof content === 'string' && content.trim()) {
			this.beginNewTurn();
			return true;
		}

		return false;
	}

	private handleProgressRecord(record: Record<string, unknown>): boolean {
		const parentToolId = record.parentToolUseID;
		if (typeof parentToolId !== 'string') {
			return false;
		}

		const data = record.data;
		if (!data || typeof data !== 'object') {
			return false;
		}

		const dataRecord = data as Record<string, unknown>;
		const dataType = dataRecord.type;
		if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
			if (this.tools.has(parentToolId)) {
				this.currentState = UNIFIED_AGENT_STATE.RUNNING;
				this.startPermissionTimer();
				return true;
			}
			return false;
		}

		if (this.tools.get(parentToolId)?.name !== 'Task') {
			return false;
		}

		const msg = dataRecord.message;
		if (!msg || typeof msg !== 'object') {
			return false;
		}

		const msgRecord = msg as Record<string, unknown>;
		const messageType = msgRecord.type;
		const innerMessage = msgRecord.message;
		if (!innerMessage || typeof innerMessage !== 'object') {
			return false;
		}

		const content = (innerMessage as { content?: unknown }).content;
		if (!Array.isArray(content)) {
			return false;
		}

		if (!this.subagents.has(parentToolId)) {
			const parentStatus = this.tools.get(parentToolId)?.status || 'Subtask';
			this.subagents.set(parentToolId, {
				label: parentStatus.startsWith('Subtask:') ? parentStatus.slice('Subtask:'.length).trim() : 'Subtask',
				parentToolId,
				tools: new Map<string, ToolState>(),
			});
		}

		const subagent = this.subagents.get(parentToolId);
		if (!subagent) {
			return false;
		}

		if (messageType === 'assistant') {
			const blocks = content as Array<{
				id?: string;
				input?: Record<string, unknown>;
				name?: string;
				type?: string;
			}>;
			let hasNonExemptSubTool = false;
			for (const block of blocks) {
				if (block.type !== 'tool_use' || !block.id) {
					continue;
				}
				const toolName = block.name || '';
				const toolId = block.id;
				subagent.tools.set(toolId, {
					done: false,
					name: toolName,
					permissionWait: false,
					status: formatToolStatus(toolName, block.input || {}),
					toolId,
				});
				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					hasNonExemptSubTool = true;
				}
			}
			this.currentState = pickDominantState(Array.from(subagent.tools.values()).map((tool) => tool.name));
			if (hasNonExemptSubTool) {
				this.startPermissionTimer();
			}
			return true;
		}

		if (messageType === 'user') {
			const blocks = content as Array<{ tool_use_id?: string; type?: string }>;
			for (const block of blocks) {
				if (block.type !== 'tool_result' || !block.tool_use_id) {
					continue;
				}
				const existing = subagent.tools.get(block.tool_use_id);
				if (existing) {
					existing.done = true;
					existing.permissionWait = false;
				}
			}
			if (Array.from(subagent.tools.values()).some((tool) => !tool.done && !PERMISSION_EXEMPT_TOOLS.has(tool.name))) {
				this.startPermissionTimer();
			}
			return true;
		}

		return false;
	}

	private beginNewTurn(): void {
		this.cancelWaitingTimer();
		this.clearPermissionWaitFlags();
		this.tools.clear();
		this.subagents.clear();
		this.hadToolsInTurn = false;
		this.isWaiting = false;
		this.currentState = UNIFIED_AGENT_STATE.RUNNING;
	}

	private markToolDone(toolId: string): void {
		const tool = this.tools.get(toolId);
		if (tool) {
			tool.done = true;
			tool.permissionWait = false;
			if (tool.name === 'Task') {
				this.subagents.delete(toolId);
			}
		}

		for (const subagent of this.subagents.values()) {
			const subTool = subagent.tools.get(toolId);
			if (!subTool) {
				continue;
			}
			subTool.done = true;
			subTool.permissionWait = false;
		}
	}

	private cancelPermissionTimer(): void {
		if (!this.permissionTimer) {
			return;
		}
		clearTimeout(this.permissionTimer);
		this.permissionTimer = null;
	}

	private cancelWaitingTimer(): void {
		if (!this.waitingTimer) {
			return;
		}
		clearTimeout(this.waitingTimer);
		this.waitingTimer = null;
	}

	private clearPermissionWaitFlags(): void {
		this.cancelPermissionTimer();
		if (!this.permissionSent) {
			return;
		}
		this.permissionSent = false;
		for (const tool of this.tools.values()) {
			tool.permissionWait = false;
		}
		for (const subagent of this.subagents.values()) {
			for (const tool of subagent.tools.values()) {
				tool.permissionWait = false;
			}
		}
		this.emit();
	}

	private startPermissionTimer(): void {
		this.cancelPermissionTimer();
		this.permissionTimer = setTimeout(() => {
			this.permissionTimer = null;
			let hasPermissionWait = false;

			for (const tool of this.tools.values()) {
				if (!tool.done && !PERMISSION_EXEMPT_TOOLS.has(tool.name)) {
					tool.permissionWait = true;
					hasPermissionWait = true;
				}
			}

			for (const subagent of this.subagents.values()) {
				for (const tool of subagent.tools.values()) {
					if (!tool.done && !PERMISSION_EXEMPT_TOOLS.has(tool.name)) {
						tool.permissionWait = true;
						hasPermissionWait = true;
					}
				}
			}

			if (hasPermissionWait) {
				this.permissionSent = true;
				this.emit();
			}
		}, CLAUDE_PERMISSION_TIMER_DELAY_MS);
	}

	private startWaitingTimer(delayMs: number): void {
		this.cancelWaitingTimer();
		this.waitingTimer = setTimeout(() => {
			this.waitingTimer = null;
			this.isWaiting = true;
			this.currentState = UNIFIED_AGENT_STATE.WAITING_INPUT;
			this.emit();
		}, delayMs);
	}
}

function stripToolName(tool: ToolState): AgentToolSnapshot {
	return {
		done: tool.done,
		permissionWait: tool.permissionWait,
		status: tool.status,
		toolId: tool.toolId,
	};
}

function pickDominantState(toolNames: string[]): UnifiedAgentState {
	if (toolNames.some((name) => WRITING_TOOLS.has(name))) {
		return UNIFIED_AGENT_STATE.WRITING;
	}
	if (toolNames.some((name) => READING_TOOLS.has(name))) {
		return UNIFIED_AGENT_STATE.READING;
	}
	if (toolNames.some((name) => name === 'EnterPlanMode' || name === 'Task')) {
		return UNIFIED_AGENT_STATE.THINKING;
	}
	if (toolNames.some((name) => name === 'AskUserQuestion')) {
		return UNIFIED_AGENT_STATE.WAITING_INPUT;
	}
	return UNIFIED_AGENT_STATE.RUNNING;
}

function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
	const base = (value: unknown) => typeof value === 'string' ? path.basename(value) : '';

	switch (toolName) {
		case 'AskUserQuestion':
			return 'Waiting for your answer';
		case 'Bash': {
			const command = typeof input.command === 'string' ? input.command : '';
			const shortened = command.length > BASH_COMMAND_DISPLAY_MAX_LENGTH
				? `${command.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH)}...`
				: command;
			return `Running: ${shortened}`;
		}
		case 'Edit':
			return `Editing ${base(input.file_path)}`;
		case 'EnterPlanMode':
			return 'Planning';
		case 'Glob':
			return 'Searching files';
		case 'Grep':
			return 'Searching code';
		case 'NotebookEdit':
			return 'Editing notebook';
		case 'Read':
			return `Reading ${base(input.file_path)}`;
		case 'Task': {
			const description = typeof input.description === 'string' ? input.description : '';
			const shortened = description.length > CLAUDE_TASK_DESCRIPTION_DISPLAY_MAX_LENGTH
				? `${description.slice(0, CLAUDE_TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}...`
				: description;
			return shortened ? `Subtask: ${shortened}` : 'Running subtask';
		}
		case 'WebFetch':
			return 'Fetching web content';
		case 'WebSearch':
			return 'Searching the web';
		case 'Write':
			return `Writing ${base(input.file_path)}`;
		default:
			return `Using ${toolName}`;
	}
}
