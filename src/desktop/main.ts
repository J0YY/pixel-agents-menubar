import * as fs from 'fs';
import * as path from 'path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import type { Event, IpcMainEvent } from 'electron';
import {
	loadCharacterSprites,
	loadDefaultLayout,
	loadFloorTiles,
	loadFurnitureAssets,
	loadWallTiles,
	sendAssetsToWebview,
	sendCharacterSpritesToWebview,
	sendFloorTilesToWebview,
	sendWallTilesToWebview,
} from '../assetLoader.js';
import { getClaudeProjectsRoot } from '../claudePaths.js';
import { readLayoutFromFile, watchLayoutFile, writeLayoutToFile } from '../layoutPersistence.js';
import type { LayoutWatcher } from '../layoutPersistence.js';
import { DesktopAgentService } from './desktopAgentService.js';
import { DesktopStateStore } from './stateStore.js';
import { PixelAgentsLogger } from '../agents/logger.js';
import { ProcessScanner } from '../agents/processScanner.js';
import { TerminalController } from '../agents/terminalController.js';
import { TerminalSessionService } from './terminalSessionService.js';

const DESKTOP_SCAN_INTERVAL_MS = 3000;

const WINDOW_HEIGHT = 860;
const WINDOW_WIDTH = 1280;

class PixelAgentsDesktopApp {
	private readonly agentService: DesktopAgentService;
	private readonly logger = new PixelAgentsLogger();
	private readonly processScanner = new ProcessScanner(this.logger);
	private readonly stateStore: DesktopStateStore;
	private readonly terminalController = new TerminalController(() => this.processScanner.scan());
	private readonly terminalSessionService: TerminalSessionService;
	private defaultLayout: Record<string, unknown> | null = null;
	private isQuitting = false;
	private layoutWatcher: LayoutWatcher | null = null;
	private tray: Tray | null = null;
	private window: BrowserWindow | null = null;

	constructor() {
		const statePath = path.join(app.getPath('userData'), 'desktop-state.json');
		this.stateStore = new DesktopStateStore(statePath);
		this.agentService = new DesktopAgentService(this.stateStore, this.logger, this.processScanner, this.terminalController);
		this.terminalSessionService = new TerminalSessionService(
			this.stateStore,
			this.processScanner,
			this.terminalController,
			this.logger,
			DESKTOP_SCAN_INTERVAL_MS,
		);
	}

	async start(): Promise<void> {
		if (process.platform === 'darwin') {
			app.dock?.hide();
			app.setActivationPolicy('accessory');
		}

		this.agentService.start();
		this.terminalSessionService.start();
		this.createWindow();
		this.createTray();
		this.registerIpc();
		await this.loadDefaultLayout();
	}

	dispose(): void {
		this.isQuitting = true;
		this.layoutWatcher?.dispose();
		this.layoutWatcher = null;
		this.agentService.dispose();
		this.terminalSessionService.dispose();
	}

	private createWindow(): void {
		this.window = new BrowserWindow({
			frame: false,
			height: WINDOW_HEIGHT,
			resizable: true,
			show: false,
			title: 'Pixel Agents',
			webPreferences: {
				contextIsolation: true,
				preload: path.join(__dirname, 'preload.js'),
			},
			width: WINDOW_WIDTH,
		});

		this.window.on('blur', () => {
			this.window?.hide();
		});

		this.window.on('close', (event: Event) => {
			if (!this.isQuitting) {
				event.preventDefault();
				this.window?.hide();
			}
		});

		this.window.webContents.on('did-finish-load', () => {
			const messageTarget = {
				postMessage: (message: unknown) => {
					this.window?.webContents.send('pixel-agents:message', message);
				},
			};
			this.agentService.setMessageTarget(messageTarget);
			this.terminalSessionService.setMessageTarget(messageTarget);
		});

		void this.window.loadFile(path.join(resolveAppRoot(), 'dist', 'webview', 'index.html'));
	}

	private createTray(): void {
		const iconPath = path.join(resolveAppRoot(), 'icon.png');
		const icon = nativeImage.createFromPath(iconPath).resize({ height: 18, width: 18 });
		this.tray = new Tray(icon);
		this.tray.setToolTip('Pixel Agents');
		this.tray.setContextMenu(Menu.buildFromTemplate([
			{ click: () => this.toggleWindow(), label: 'Show Pixel Agents' },
			{ role: 'quit', label: 'Quit' },
		]));
		this.tray.on('click', () => this.toggleWindow());
	}

	private toggleWindow(): void {
		if (!this.window) {
			return;
		}

		if (this.window.isVisible()) {
			this.window.hide();
			return;
		}

		this.window.show();
		this.window.focus();
	}

	private registerIpc(): void {
		ipcMain.on('pixel-agents:message', async (_event: IpcMainEvent, message: unknown) => {
			const payload = message as {
				enabled?: boolean;
				folderPath?: string;
				id?: number;
				layout?: Record<string, unknown>;
				seats?: Record<string, { hueShift?: number; palette?: number; seatId?: string }>;
				sessionId?: string;
				sessionLabel?: string;
				type?: string;
			};
			switch (payload.type) {
				case 'closeAgent':
					if (typeof payload.id === 'number') {
						this.agentService.closeAgent(payload.id);
					}
					break;
				case 'exportLayout':
					await this.exportLayout();
					break;
				case 'focusAgent':
					if (typeof payload.id === 'number') {
						this.agentService.focusAgent(payload.id);
					}
					break;
				case 'focusTerminalSession':
					if (typeof payload.sessionId === 'string') {
						await this.terminalSessionService.focusSession(payload.sessionId);
					}
					break;
				case 'importLayout':
					await this.importLayout();
					break;
				case 'openClaude':
					await this.agentService.launchClaude(payload.folderPath);
					break;
				case 'openCodex':
					await this.agentService.launchCodex(payload.folderPath);
					break;
				case 'openTerminal':
					await this.terminalSessionService.launchShell(payload.folderPath);
					break;
				case 'openSessionsFolder':
					await shell.openPath(getClaudeProjectsRoot());
					break;
				case 'quitApp':
					this.isQuitting = true;
					app.quit();
					break;
				case 'saveAgentSeats':
					if (payload.seats) {
						this.stateStore.setAgentMeta(payload.seats);
					}
					break;
				case 'saveLayout':
					if (payload.layout) {
						this.layoutWatcher?.markOwnWrite();
						writeLayoutToFile(payload.layout);
					}
					break;
				case 'setSoundEnabled':
					this.stateStore.setSoundEnabled(Boolean(payload.enabled));
					break;
				case 'terminateTerminalSession':
					if (typeof payload.sessionId === 'string') {
						this.terminalSessionService.terminateSession(payload.sessionId);
					}
					break;
				case 'renameTerminalSession':
					if (typeof payload.sessionId === 'string') {
						this.terminalSessionService.renameSession(payload.sessionId, payload.sessionLabel);
					}
					break;
				case 'webviewReady':
					this.sendHostBootstrap();
					break;
				default:
					break;
			}
		});
	}

	private async sendHostBootstrap(): Promise<void> {
		const target = this.getMessageTarget();
		if (!target) {
			return;
		}

		target.postMessage({
			type: 'hostContext',
			canLaunchClaude: true,
			canLaunchCodex: true,
			canManageTerminals: true,
			mode: 'desktop',
		});
		target.postMessage({
			type: 'settingsLoaded',
			soundEnabled: this.stateStore.getSoundEnabled(),
		});
		await this.sendAssets(target);

		if (!readLayoutFromFile() && this.defaultLayout) {
			writeLayoutToFile(this.defaultLayout);
		}

		target.postMessage({
			type: 'layoutLoaded',
			layout: readLayoutFromFile() ?? this.defaultLayout,
		});

		this.startLayoutWatcher();
		this.agentService.markRendererReady();
	}

	private getMessageTarget(): { postMessage: (message: unknown) => void } | null {
		if (!this.window) {
			return null;
		}
		return {
			postMessage: (message: unknown) => {
				this.window?.webContents.send('pixel-agents:message', message);
			},
		};
	}

	private async loadDefaultLayout(): Promise<void> {
		this.defaultLayout = loadDefaultLayout(resolveAssetsRoot());
	}

	private async sendAssets(target: { postMessage: (message: unknown) => void }): Promise<void> {
		const assetsRoot = resolveAssetsRoot();
		const characterSprites = await loadCharacterSprites(assetsRoot);
		if (characterSprites) {
			sendCharacterSpritesToWebview(target, characterSprites);
		}
		const floorTiles = await loadFloorTiles(assetsRoot);
		if (floorTiles) {
			sendFloorTilesToWebview(target, floorTiles);
		}
		const wallTiles = await loadWallTiles(assetsRoot);
		if (wallTiles) {
			sendWallTilesToWebview(target, wallTiles);
		}
		const assets = await loadFurnitureAssets(assetsRoot);
		if (assets) {
			sendAssetsToWebview(target, assets);
		}
	}

	private startLayoutWatcher(): void {
		if (this.layoutWatcher) {
			return;
		}

		const target = this.getMessageTarget();
		if (!target) {
			return;
		}

		this.layoutWatcher = watchLayoutFile((layout) => {
			target.postMessage({ type: 'layoutLoaded', layout });
		});
	}

	private async exportLayout(): Promise<void> {
		const layout = readLayoutFromFile();
		if (!layout) {
			return;
		}

		const options = {
			defaultPath: path.join(app.getPath('documents'), 'pixel-agents-layout.json'),
			filters: [{ extensions: ['json'], name: 'JSON Files' }],
		};
		const result = this.window
			? await dialog.showSaveDialog(this.window, options)
			: await dialog.showSaveDialog(options);
		if (!result.filePath) {
			return;
		}
		fs.writeFileSync(result.filePath, JSON.stringify(layout, null, 2), 'utf-8');
	}

	private async importLayout(): Promise<void> {
		const options = {
			canSelectMany: false,
			filters: [{ extensions: ['json'], name: 'JSON Files' }],
		};
		const result = this.window
			? await dialog.showOpenDialog(this.window, options)
			: await dialog.showOpenDialog(options);
		const filePath = result.filePaths[0];
		if (!filePath) {
			return;
		}

		const raw = fs.readFileSync(filePath, 'utf-8');
		const layout = JSON.parse(raw) as Record<string, unknown>;
		this.layoutWatcher?.markOwnWrite();
		writeLayoutToFile(layout);
		this.getMessageTarget()?.postMessage({ type: 'layoutLoaded', layout });
	}
}

function resolveAppRoot(): string {
	return path.resolve(__dirname, '..', '..');
}

function resolveAssetsRoot(): string {
	const distAssets = path.join(resolveAppRoot(), 'dist', 'assets');
	if (fs.existsSync(distAssets)) {
		return path.join(resolveAppRoot(), 'dist');
	}
	return resolveAppRoot();
}

void app.whenReady().then(async () => {
	const desktopApp = new PixelAgentsDesktopApp();
	app.on('before-quit', () => {
		desktopApp.dispose();
	});
	await desktopApp.start();
});
