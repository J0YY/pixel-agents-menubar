import { DesktopStateStore } from './stateStore.js';
import { PixelAgentsLogger } from '../agents/logger.js';
import { ProcessScanner } from '../agents/processScanner.js';
import { TerminalController } from '../agents/terminalController.js';
import { AgentRegistry } from '../agents/registry.js';
import { ExternalClaudeProvider } from '../agents/providers/ExternalClaudeProvider.js';
import { ExternalCodexProvider } from '../agents/providers/ExternalCodexProvider.js';

export class DesktopAgentService {
	private readonly registry: AgentRegistry;
	private readonly externalClaudeProvider: ExternalClaudeProvider;
	private readonly externalCodexProvider: ExternalCodexProvider;

	constructor(
		private readonly stateStore: DesktopStateStore,
		private readonly logger: PixelAgentsLogger = new PixelAgentsLogger(),
		private readonly processScanner: ProcessScanner = new ProcessScanner(logger),
		private readonly terminalController: TerminalController = new TerminalController(() => processScanner.scan()),
	) {
		this.registry = new AgentRegistry(this.logger, {
			getAgentMeta: () => this.stateStore.getAgentMeta(),
		});
		this.externalClaudeProvider = new ExternalClaudeProvider(this.registry, this.processScanner, this.logger, {
			enableTranscriptCorrelation: true,
			scanIntervalMs: 3000,
			terminalController: this.terminalController,
		});
		this.externalCodexProvider = new ExternalCodexProvider(this.registry, this.processScanner, this.logger, {
			scanIntervalMs: 3000,
			terminalController: this.terminalController,
		});
		this.registry.registerProvider(this.externalClaudeProvider);
		this.registry.registerProvider(this.externalCodexProvider);
	}

	start(): void {
		this.registry.start();
		this.externalClaudeProvider.start();
		this.externalCodexProvider.start();
	}

	dispose(): void {
		this.externalClaudeProvider.dispose();
		this.externalCodexProvider.dispose();
		this.registry.dispose();
	}

	setMessageTarget(messageTarget: { postMessage: (message: unknown) => void } | undefined): void {
		this.registry.setMessageTarget(messageTarget);
	}

	markRendererReady(): void {
		this.registry.markWebviewReady();
	}

	focusAgent(visualId: number): void {
		this.registry.focusVisualAgent(visualId);
	}

	closeAgent(visualId: number): void {
		this.registry.closeVisualAgent(visualId);
	}

	async launchClaude(folderPath?: string): Promise<void> {
		await this.terminalController.launchClaude(folderPath);
	}

	async launchCodex(folderPath?: string): Promise<void> {
		await this.terminalController.launchCodex(folderPath);
	}
}
