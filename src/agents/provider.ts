import type * as vscode from 'vscode';

export interface AgentProvider extends vscode.Disposable {
	readonly id: string;
	closeSession?(providerSessionId: string): void | Promise<void>;
	focusSession?(providerSessionId: string): void | Promise<void>;
	start(): void;
}
