import * as fs from 'fs';
import * as path from 'path';

interface DesktopState {
	agentSeats: Record<string, { hueShift?: number; palette?: number; seatId?: string }>;
	soundEnabled: boolean;
}

const DEFAULT_STATE: DesktopState = {
	agentSeats: {},
	soundEnabled: true,
};

export class DesktopStateStore {
	private state: DesktopState = DEFAULT_STATE;

	constructor(private readonly filePath: string) {
		this.state = this.readState();
	}

	getAgentMeta(): Record<string, { hueShift?: number; palette?: number; seatId?: string }> {
		return this.state.agentSeats;
	}

	setAgentMeta(agentSeats: Record<string, { hueShift?: number; palette?: number; seatId?: string }>): void {
		this.state = {
			...this.state,
			agentSeats,
		};
		this.writeState();
	}

	getSoundEnabled(): boolean {
		return this.state.soundEnabled;
	}

	setSoundEnabled(soundEnabled: boolean): void {
		this.state = {
			...this.state,
			soundEnabled,
		};
		this.writeState();
	}

	private readState(): DesktopState {
		try {
			if (!fs.existsSync(this.filePath)) {
				return DEFAULT_STATE;
			}
			const raw = fs.readFileSync(this.filePath, 'utf-8');
			const parsed = JSON.parse(raw) as Partial<DesktopState>;
			return {
				agentSeats: parsed.agentSeats ?? {},
				soundEnabled: parsed.soundEnabled ?? true,
			};
		} catch {
			return DEFAULT_STATE;
		}
	}

	private writeState(): void {
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
		} catch {
			// Ignore persistence failures in MVP.
		}
	}
}

