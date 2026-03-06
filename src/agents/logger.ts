export class PixelAgentsLogger {
	constructor(private readonly getDebugEnabled: () => boolean = () => false) {
		this.refresh();
	}

	private debugEnabled = false;

	refresh(): void {
		this.debugEnabled = this.getDebugEnabled();
	}

	debug(message: string, payload?: unknown): void {
		if (!this.debugEnabled) {
			return;
		}
		this.write('log', message, payload);
	}

	error(message: string, payload?: unknown): void {
		this.write('error', message, payload);
	}

	warn(message: string, payload?: unknown): void {
		this.write('warn', message, payload);
	}

	private write(level: 'error' | 'log' | 'warn', message: string, payload?: unknown): void {
		const prefix = `[Pixel Agents] ${message}`;
		if (payload === undefined) {
			console[level](prefix);
			return;
		}
		console[level](prefix, payload);
	}
}
