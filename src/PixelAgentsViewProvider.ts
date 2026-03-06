import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getClaudeProjectDirPath } from './claudePaths.js';
import { loadFurnitureAssets, sendAssetsToWebview, loadFloorTiles, sendFloorTilesToWebview, loadWallTiles, sendWallTilesToWebview, loadCharacterSprites, sendCharacterSpritesToWebview, loadDefaultLayout } from './assetLoader.js';
import { WORKSPACE_KEY_AGENT_SEATS, GLOBAL_KEY_SOUND_ENABLED } from './constants.js';
import { migrateAndLoadLayout, writeLayoutToFile, readLayoutFromFile, watchLayoutFile } from './layoutPersistence.js';
import type { LayoutWatcher } from './layoutPersistence.js';
import { AgentSystem } from './agents/agentSystem.js';

export class PixelAgentsViewProvider implements vscode.WebviewViewProvider {
	private readonly agentSystem: AgentSystem;
	webviewView: vscode.WebviewView | undefined;

	// Bundled default layout (loaded from assets/default-layout.json)
	defaultLayout: Record<string, unknown> | null = null;

	// Cross-window layout sync
	layoutWatcher: LayoutWatcher | null = null;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.agentSystem = new AgentSystem(context);
	}

	private get extensionUri(): vscode.Uri {
		return this.context.extensionUri;
	}

	private get webview(): vscode.Webview | undefined {
		return this.webviewView?.webview;
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.webviewView = webviewView;
		this.agentSystem.setWebview(webviewView.webview);
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

		webviewView.webview.onDidReceiveMessage(async (message) => {
			if (message.type === 'openClaude') {
				await this.agentSystem.launchClaude(message.folderPath as string | undefined);
			} else if (message.type === 'focusAgent') {
				this.agentSystem.focusAgent(message.id as number);
			} else if (message.type === 'closeAgent') {
				this.agentSystem.closeAgent(message.id as number);
			} else if (message.type === 'saveAgentSeats') {
				// Store seat assignments in a separate key (never touched by persistAgents)
				console.log(`[Pixel Agents] saveAgentSeats:`, JSON.stringify(message.seats));
				this.context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, message.seats);
			} else if (message.type === 'saveLayout') {
				this.layoutWatcher?.markOwnWrite();
				writeLayoutToFile(message.layout as Record<string, unknown>);
			} else if (message.type === 'setSoundEnabled') {
				this.context.globalState.update(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
			} else if (message.type === 'webviewReady') {
				this.webview?.postMessage({
					type: 'hostContext',
					canLaunchClaude: true,
					canLaunchCodex: false,
					mode: 'vscode',
				});
				this.agentSystem.markWebviewReady();
				// Send persisted settings to webview
				const soundEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
				this.webview?.postMessage({ type: 'settingsLoaded', soundEnabled });

				// Send workspace folders to webview (only when multi-root)
				const wsFolders = vscode.workspace.workspaceFolders;
				if (wsFolders && wsFolders.length > 1) {
					this.webview?.postMessage({
						type: 'workspaceFolders',
						folders: wsFolders.map(f => ({ name: f.name, path: f.uri.fsPath })),
					});
				}
				await this.loadAssetsAndLayout();
			} else if (message.type === 'openSessionsFolder') {
				const projectDir = getClaudeProjectDirPath(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
				if (projectDir && fs.existsSync(projectDir)) {
					vscode.env.openExternal(vscode.Uri.file(projectDir));
				}
			} else if (message.type === 'exportLayout') {
				const layout = readLayoutFromFile();
				if (!layout) {
					vscode.window.showWarningMessage('Pixel Agents: No saved layout to export.');
					return;
				}
				const uri = await vscode.window.showSaveDialog({
					filters: { 'JSON Files': ['json'] },
					defaultUri: vscode.Uri.file(path.join(os.homedir(), 'pixel-agents-layout.json')),
				});
				if (uri) {
					fs.writeFileSync(uri.fsPath, JSON.stringify(layout, null, 2), 'utf-8');
					vscode.window.showInformationMessage('Pixel Agents: Layout exported successfully.');
				}
			} else if (message.type === 'importLayout') {
				const uris = await vscode.window.showOpenDialog({
					filters: { 'JSON Files': ['json'] },
					canSelectMany: false,
				});
				if (!uris || uris.length === 0) {
					return;
				}
				try {
					const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
					const imported = JSON.parse(raw) as Record<string, unknown>;
					if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
						vscode.window.showErrorMessage('Pixel Agents: Invalid layout file.');
						return;
					}
					this.layoutWatcher?.markOwnWrite();
					writeLayoutToFile(imported);
					this.webview?.postMessage({ type: 'layoutLoaded', layout: imported });
					vscode.window.showInformationMessage('Pixel Agents: Layout imported successfully.');
				} catch {
					vscode.window.showErrorMessage('Pixel Agents: Failed to read or parse layout file.');
				}
			}
		});
	}

	/** Export current saved layout to webview-ui/public/assets/default-layout.json (dev utility) */
	exportDefaultLayout(): void {
		const layout = readLayoutFromFile();
		if (!layout) {
			vscode.window.showWarningMessage('Pixel Agents: No saved layout found.');
			return;
		}
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			vscode.window.showErrorMessage('Pixel Agents: No workspace folder found.');
			return;
		}
		const targetPath = path.join(workspaceRoot, 'webview-ui', 'public', 'assets', 'default-layout.json');
		const json = JSON.stringify(layout, null, 2);
		fs.writeFileSync(targetPath, json, 'utf-8');
		vscode.window.showInformationMessage(`Pixel Agents: Default layout exported to ${targetPath}`);
	}

	private startLayoutWatcher(): void {
		if (this.layoutWatcher) {
			return;
		}
		this.layoutWatcher = watchLayoutFile((layout) => {
			console.log('[Pixel Agents] External layout change — pushing to webview');
			this.webview?.postMessage({ type: 'layoutLoaded', layout });
		});
	}

	private sendLayout(): void {
		if (!this.webview) {
			return;
		}
		const layout = migrateAndLoadLayout(this.context, this.defaultLayout);
		this.webview.postMessage({
			type: 'layoutLoaded',
			layout,
		});
	}

	private async loadAssetsAndLayout(): Promise<void> {
		try {
			const assetsRoot = this.resolveAssetsRoot();
			if (assetsRoot) {
				this.defaultLayout = loadDefaultLayout(assetsRoot);
				await this.loadAndSendAssets(assetsRoot);
			} else {
				this.defaultLayout = null;
			}
		} catch (error) {
			console.error('[Extension] Failed to load assets', error);
		}

		this.sendLayout();
		this.startLayoutWatcher();
	}

	private async loadAndSendAssets(assetsRoot: string): Promise<void> {
		if (!this.webview) {
			return;
		}

		const characterSprites = await loadCharacterSprites(assetsRoot);
		if (characterSprites) {
			sendCharacterSpritesToWebview(this.webview, characterSprites);
		}

		const floorTiles = await loadFloorTiles(assetsRoot);
		if (floorTiles) {
			sendFloorTilesToWebview(this.webview, floorTiles);
		}

		const wallTiles = await loadWallTiles(assetsRoot);
		if (wallTiles) {
			sendWallTilesToWebview(this.webview, wallTiles);
		}

		const assets = await loadFurnitureAssets(assetsRoot);
		if (assets) {
			sendAssetsToWebview(this.webview, assets);
		}
	}

	private resolveAssetsRoot(): string | null {
		const extensionPath = this.extensionUri.fsPath;
		const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
		if (fs.existsSync(bundledAssetsDir)) {
			return path.join(extensionPath, 'dist');
		}

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		return workspaceRoot ?? null;
	}

	dispose() {
		this.layoutWatcher?.dispose();
		this.layoutWatcher = null;
		this.agentSystem.dispose();
	}
}

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
	const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

	let html = fs.readFileSync(indexPath, 'utf-8');

	html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
		const fileUri = vscode.Uri.joinPath(distPath, filePath);
		const webviewUri = webview.asWebviewUri(fileUri);
		return `${attr}="${webviewUri}"`;
	});

	return html;
}
