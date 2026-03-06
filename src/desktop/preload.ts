import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

declare const window: {
	postMessage(message: unknown, targetOrigin: string): void;
};

contextBridge.exposeInMainWorld('pixelAgentsHost', {
	postMessage: (message: unknown) => {
		ipcRenderer.send('pixel-agents:message', message);
	},
});

ipcRenderer.on('pixel-agents:message', (_event: IpcRendererEvent, message: unknown) => {
	window.postMessage(message, '*');
});
