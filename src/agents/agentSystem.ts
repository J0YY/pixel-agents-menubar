import * as vscode from 'vscode';
import { WORKSPACE_KEY_AGENT_SEATS } from '../constants.js';
import { getPixelAgentsConfig } from './config.js';
import { PixelAgentsLogger } from './logger.js';
import type { AgentProvider } from './provider.js';
import { ProcessScanner } from './processScanner.js';
import { AgentRegistry } from './registry.js';
import { TerminalController } from './terminalController.js';
import { ClaudeVSCodeProvider } from './providers/ClaudeVSCodeProvider.js';
import { ExternalClaudeProvider } from './providers/ExternalClaudeProvider.js';
import { ExternalCodexProvider } from './providers/ExternalCodexProvider.js';

export class AgentSystem implements vscode.Disposable {
	private readonly claudeVSCodeProvider: ClaudeVSCodeProvider;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly logger: PixelAgentsLogger;
	private readonly processScanner: ProcessScanner;
	private readonly registry: AgentRegistry;
	private readonly terminalController: TerminalController;
	private externalProviders: AgentProvider[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		this.logger = new PixelAgentsLogger(() => getPixelAgentsConfig().debugLogging);
		this.registry = new AgentRegistry(this.logger, {
			getAgentMeta: () => this.context.workspaceState.get(WORKSPACE_KEY_AGENT_SEATS, {}),
		});
		this.registry.start();
		this.processScanner = new ProcessScanner(this.logger);
		this.terminalController = new TerminalController(() => this.processScanner.scan());
		this.claudeVSCodeProvider = new ClaudeVSCodeProvider(context, this.registry, this.logger);
		this.registry.registerProvider(this.claudeVSCodeProvider);
		this.claudeVSCodeProvider.start();
		this.refreshExternalProviders();

		this.disposables.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('pixelAgents.logging.debug')) {
					this.logger.refresh();
				}
				if (event.affectsConfiguration('pixelAgents.externalTracking') || event.affectsConfiguration('pixelAgents.logging.debug')) {
					this.refreshExternalProviders();
				}
			}),
		);
	}

	dispose(): void {
		for (const provider of this.externalProviders) {
			provider.dispose();
		}
		this.externalProviders = [];

		this.claudeVSCodeProvider.dispose();
		this.registry.dispose();

		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.disposables.length = 0;
	}

	setWebview(webview: vscode.Webview | undefined): void {
		this.registry.setMessageTarget(webview);
	}

	markWebviewReady(): void {
		this.claudeVSCodeProvider.restoreSessions();
		this.registry.markWebviewReady();
	}

	async launchClaude(folderPath?: string): Promise<void> {
		await this.claudeVSCodeProvider.launchAgent(folderPath);
	}

	focusAgent(visualId: number): void {
		this.registry.focusVisualAgent(visualId);
	}

	closeAgent(visualId: number): void {
		this.registry.closeVisualAgent(visualId);
	}

	private refreshExternalProviders(): void {
		for (const provider of this.externalProviders) {
			provider.dispose();
		}
		this.externalProviders = [];

		const config = getPixelAgentsConfig();
		if (process.platform !== 'darwin' || !config.externalTracking.enabled) {
			this.logger.debug('External agent tracking disabled', {
				platform: process.platform,
			});
			return;
		}

		if (config.externalTracking.enableClaude) {
			const provider = new ExternalClaudeProvider(this.registry, this.processScanner, this.logger, {
				enableTranscriptCorrelation: config.externalTracking.enableTranscriptCorrelation,
				scanIntervalMs: config.externalTracking.scanIntervalMs,
				terminalController: this.terminalController,
			});
			this.registry.registerProvider(provider);
			provider.start();
			this.externalProviders.push(provider);
			this.logger.debug('Started external Claude provider');
		}

		if (config.externalTracking.enableCodex) {
			const provider = new ExternalCodexProvider(this.registry, this.processScanner, this.logger, {
				scanIntervalMs: config.externalTracking.scanIntervalMs,
				terminalController: this.terminalController,
			});
			this.registry.registerProvider(provider);
			provider.start();
			this.externalProviders.push(provider);
			this.logger.debug('Started external Codex provider');
		}
	}
}
