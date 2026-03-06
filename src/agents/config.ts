import * as vscode from 'vscode';
import { EXTERNAL_TRACKING_SCAN_INTERVAL_MS_DEFAULT, EXTERNAL_TRACKING_SCAN_INTERVAL_MS_MIN } from '../constants.js';

export interface PixelAgentsConfig {
	debugLogging: boolean;
	externalTracking: {
		enableClaude: boolean;
		enableCodex: boolean;
		enableTranscriptCorrelation: boolean;
		enabled: boolean;
		scanIntervalMs: number;
	};
}

export function getPixelAgentsConfig(): PixelAgentsConfig {
	const config = vscode.workspace.getConfiguration('pixelAgents');
	return {
		debugLogging: config.get<boolean>('logging.debug', false),
		externalTracking: {
			enableClaude: config.get<boolean>('externalTracking.enableClaude', true),
			enableCodex: config.get<boolean>('externalTracking.enableCodex', true),
			enableTranscriptCorrelation: config.get<boolean>('externalTracking.enableTranscriptCorrelation', true),
			enabled: config.get<boolean>('externalTracking.enabled', process.platform === 'darwin'),
			scanIntervalMs: clampScanInterval(
				config.get<number>('externalTracking.scanIntervalMs', EXTERNAL_TRACKING_SCAN_INTERVAL_MS_DEFAULT),
			),
		},
	};
}

function clampScanInterval(value: number): number {
	return Math.max(EXTERNAL_TRACKING_SCAN_INTERVAL_MS_MIN, Math.floor(value));
}

