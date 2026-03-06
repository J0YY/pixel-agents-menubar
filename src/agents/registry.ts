import { randomUUID } from 'crypto';
import { AGENT_STALE_GRACE_MS } from '../constants.js';
import type { PixelAgentsLogger } from './logger.js';
import type { AgentProvider } from './provider.js';
import type {
	AgentObservation,
	AgentPresentation,
	AgentSubagentSnapshot,
	AgentToolSnapshot,
} from './types.js';

interface AgentRegistryOptions {
	getAgentMeta: () => Record<string, { hueShift?: number; palette?: number; seatId?: string }>;
}

interface ObservationRecord {
	groupId: string;
	key: string;
	missingSince: number | null;
	snapshot: AgentObservation;
}

interface GroupRecord {
	id: string;
	identityKeys: Set<string>;
	observationKeys: Set<string>;
	presentation: AgentPresentation | undefined;
	visualId: number | undefined;
}

export class AgentRegistry {
	private readonly groupIdByIdentityKey = new Map<string, string>();
	private readonly groups = new Map<string, GroupRecord>();
	private readonly observations = new Map<string, ObservationRecord>();
	private readonly providers = new Map<string, AgentProvider>();
	private nextVisualId = 1;
	private pruneTimer: ReturnType<typeof setInterval> | null = null;
	private messageTarget: { postMessage: (message: unknown) => void } | undefined;
	private webviewReady = false;

	constructor(
		private readonly logger: PixelAgentsLogger,
		private readonly options: AgentRegistryOptions,
	) {}

	registerProvider(provider: AgentProvider): void {
		this.providers.set(provider.id, provider);
	}

	start(): void {
		if (this.pruneTimer) {
			return;
		}
		this.pruneTimer = setInterval(() => {
			this.pruneStaleObservations();
		}, 1000);
	}

	dispose(): void {
		if (this.pruneTimer) {
			clearInterval(this.pruneTimer);
			this.pruneTimer = null;
		}
		this.webviewReady = false;
		this.messageTarget = undefined;
	}

	setMessageTarget(messageTarget: { postMessage: (message: unknown) => void } | undefined): void {
		this.messageTarget = messageTarget;
		this.webviewReady = false;
	}

	markWebviewReady(): void {
		this.webviewReady = true;
		this.sendExistingAgents();
	}

	upsertObservation(snapshot: AgentObservation): void {
		const observationKey = this.getObservationKey(snapshot.providerId, snapshot.providerSessionId);
		const normalizedSnapshot = normalizeObservation(snapshot);
		const existing = this.observations.get(observationKey);
		const isNewObservation = !existing;

		let reusableEmptyGroup: GroupRecord | undefined;
		let oldGroupToRecompute: string | undefined;

		if (existing) {
			const previousGroup = this.groups.get(existing.groupId);
			if (previousGroup) {
				previousGroup.observationKeys.delete(observationKey);
				if (previousGroup.observationKeys.size === 0) {
					reusableEmptyGroup = previousGroup;
				} else {
					this.rebuildGroupIdentityIndex(previousGroup);
					oldGroupToRecompute = previousGroup.id;
				}
			}
		}

		const matchingGroupIds = new Set<string>();
		for (const identityKey of normalizedSnapshot.identityKeys) {
			const groupId = this.groupIdByIdentityKey.get(identityKey);
			if (groupId) {
				matchingGroupIds.add(groupId);
			}
		}
		if (reusableEmptyGroup) {
			matchingGroupIds.add(reusableEmptyGroup.id);
		}

		const targetGroup = this.resolveTargetGroup(Array.from(matchingGroupIds), reusableEmptyGroup);
		const record: ObservationRecord = {
			groupId: targetGroup.id,
			key: observationKey,
			missingSince: null,
			snapshot: normalizedSnapshot,
		};

		this.observations.set(observationKey, record);
		targetGroup.observationKeys.add(observationKey);
		this.rebuildGroupIdentityIndex(targetGroup);
		if (isNewObservation) {
			this.logger.debug('Registered agent observation', {
				groupId: targetGroup.id,
				identityKeys: normalizedSnapshot.identityKeys,
				providerId: normalizedSnapshot.providerId,
				providerSessionId: normalizedSnapshot.providerSessionId,
			});
		}
		this.recomputeGroup(targetGroup.id);

		if (oldGroupToRecompute && oldGroupToRecompute !== targetGroup.id) {
			this.recomputeGroup(oldGroupToRecompute);
		}

		if (reusableEmptyGroup && reusableEmptyGroup.id !== targetGroup.id) {
			this.cleanupEmptyGroup(reusableEmptyGroup.id);
		}
	}

	removeObservation(providerId: string, providerSessionId: string, immediate = false): void {
		const observationKey = this.getObservationKey(providerId, providerSessionId);
		const observation = this.observations.get(observationKey);
		if (!observation) {
			return;
		}

		if (!immediate) {
			observation.missingSince = Date.now();
			return;
		}

		this.deleteObservation(observationKey);
	}

	replaceProviderSnapshot(providerId: string, snapshots: AgentObservation[]): void {
		const nextObservationKeys = new Set<string>();
		for (const snapshot of snapshots) {
			if (snapshot.providerId !== providerId) {
				continue;
			}
			nextObservationKeys.add(this.getObservationKey(snapshot.providerId, snapshot.providerSessionId));
			this.upsertObservation(snapshot);
		}

		for (const [observationKey, observation] of this.observations) {
			if (observation.snapshot.providerId !== providerId) {
				continue;
			}
			if (nextObservationKeys.has(observationKey)) {
				continue;
			}
			observation.missingSince = observation.missingSince ?? Date.now();
		}
	}

	clearProvider(providerId: string, immediate = true): void {
		for (const [observationKey, observation] of [...this.observations]) {
			if (observation.snapshot.providerId !== providerId) {
				continue;
			}
			if (immediate) {
				this.deleteObservation(observationKey);
			} else {
				observation.missingSince = observation.missingSince ?? Date.now();
			}
		}
	}

	getVisualIdForObservation(providerId: string, providerSessionId: string): number | undefined {
		const observation = this.observations.get(this.getObservationKey(providerId, providerSessionId));
		if (!observation) {
			return undefined;
		}
		return this.groups.get(observation.groupId)?.visualId;
	}

	focusVisualAgent(visualId: number): void {
		const observation = this.findBestObservationForVisualId(visualId, 'focusable');
		if (!observation) {
			return;
		}
		this.providers.get(observation.snapshot.providerId)?.focusSession?.(observation.snapshot.providerSessionId);
	}

	closeVisualAgent(visualId: number): void {
		const observation = this.findBestObservationForVisualId(visualId, 'closable');
		if (!observation) {
			return;
		}
		this.providers.get(observation.snapshot.providerId)?.closeSession?.(observation.snapshot.providerSessionId);
	}

	selectObservation(providerId: string, providerSessionId: string): void {
		if (!this.webviewReady || !this.messageTarget) {
			return;
		}
		const visualId = this.getVisualIdForObservation(providerId, providerSessionId);
		if (visualId === undefined) {
			return;
		}
		this.messageTarget.postMessage({ type: 'agentSelected', id: visualId });
	}

	private sendExistingAgents(): void {
		if (!this.webviewReady || !this.messageTarget) {
			return;
		}

		const presentations = [...this.groups.values()]
			.map((group) => group.presentation)
			.filter((presentation): presentation is AgentPresentation => Boolean(presentation))
			.sort((left, right) => left.visualId - right.visualId);

		const agentMeta = this.options.getAgentMeta();
		const folderNames: Record<number, string> = {};
		const agentCapabilities: Record<number, { closable?: boolean; focusable?: boolean }> = {};

		for (const presentation of presentations) {
			if (presentation.folderName) {
				folderNames[presentation.visualId] = presentation.folderName;
			}
			agentCapabilities[presentation.visualId] = presentation.capabilities;
		}

		this.messageTarget.postMessage({
			type: 'existingAgents',
			agentCapabilities,
			agentMeta,
			agents: presentations.map((presentation) => presentation.visualId),
			folderNames,
		});

		for (const presentation of presentations) {
			this.emitFullPresentation(presentation);
		}
	}

	private emitFullPresentation(presentation: AgentPresentation): void {
		if (!this.messageTarget) {
			return;
		}

		for (const tool of presentation.tools) {
			this.messageTarget.postMessage({
				type: 'agentToolStart',
				id: presentation.visualId,
				status: tool.status,
				toolId: tool.toolId,
			});
			if (tool.done) {
				this.messageTarget.postMessage({
					type: 'agentToolDone',
					id: presentation.visualId,
					toolId: tool.toolId,
				});
			}
		}

		for (const subagent of presentation.subagents) {
			for (const tool of subagent.tools) {
				this.messageTarget.postMessage({
					type: 'subagentToolStart',
					id: presentation.visualId,
					parentToolId: subagent.parentToolId,
					status: tool.status,
					toolId: tool.toolId,
				});
				if (tool.done) {
					this.messageTarget.postMessage({
						type: 'subagentToolDone',
						id: presentation.visualId,
						parentToolId: subagent.parentToolId,
						toolId: tool.toolId,
					});
				}
			}
		}

		if (hasPermissionWait(presentation)) {
			this.messageTarget.postMessage({
				type: 'agentToolPermission',
				id: presentation.visualId,
			});
			for (const parentToolId of getPermissionParentToolIds(presentation)) {
				this.messageTarget.postMessage({
					type: 'subagentToolPermission',
					id: presentation.visualId,
					parentToolId,
				});
			}
		}

		this.messageTarget.postMessage({
			type: 'agentStatus',
			id: presentation.visualId,
			status: presentation.state,
		});
	}

	private emitPresentationDiff(previous: AgentPresentation, next: AgentPresentation): void {
		if (!this.messageTarget) {
			return;
		}

		const hadTools = previous.tools.length > 0 || previous.subagents.some((subagent) => subagent.tools.length > 0);
		const hasTools = next.tools.length > 0 || next.subagents.some((subagent) => subagent.tools.length > 0);
		const structuralRemoval = hasStructuralRemoval(previous, next);

		if (hadTools && (!hasTools || structuralRemoval)) {
			this.messageTarget.postMessage({
				type: 'agentToolsClear',
				id: next.visualId,
			});
			for (const subagent of previous.subagents) {
				if (!next.subagents.some((candidate) => candidate.parentToolId === subagent.parentToolId)) {
					this.messageTarget.postMessage({
						type: 'subagentClear',
						id: next.visualId,
						parentToolId: subagent.parentToolId,
					});
				}
			}
			if (hasTools) {
				this.emitFullPresentation(next);
			}
		} else {
			this.emitToolAdditions(previous, next);
			this.emitToolCompletions(previous, next);
			this.emitSubagentChanges(previous, next);
		}

		const previousPermissionParents = getPermissionParentToolIds(previous);
		const nextPermissionParents = getPermissionParentToolIds(next);
		const previousHasPermission = previousPermissionParents.size > 0 || previous.tools.some((tool) => tool.permissionWait && !tool.done);
		const nextHasPermission = nextPermissionParents.size > 0 || next.tools.some((tool) => tool.permissionWait && !tool.done);
		if (previousHasPermission !== nextHasPermission) {
			this.messageTarget.postMessage({
				type: nextHasPermission ? 'agentToolPermission' : 'agentToolPermissionClear',
				id: next.visualId,
			});
		}
		if (nextHasPermission) {
			for (const parentToolId of nextPermissionParents) {
				if (!previousPermissionParents.has(parentToolId)) {
					this.messageTarget.postMessage({
						type: 'subagentToolPermission',
						id: next.visualId,
						parentToolId,
					});
				}
			}
		}

		if (previous.state !== next.state) {
			this.messageTarget.postMessage({
				type: 'agentStatus',
				id: next.visualId,
				status: next.state,
			});
		}
	}

	private emitToolAdditions(previous: AgentPresentation, next: AgentPresentation): void {
		if (!this.messageTarget) {
			return;
		}

		const previousTools = new Map(previous.tools.map((tool) => [tool.toolId, tool]));
		for (const tool of next.tools) {
			if (!previousTools.has(tool.toolId)) {
				this.messageTarget.postMessage({
					type: 'agentToolStart',
					id: next.visualId,
					status: tool.status,
					toolId: tool.toolId,
				});
			}
		}
	}

	private emitToolCompletions(previous: AgentPresentation, next: AgentPresentation): void {
		if (!this.messageTarget) {
			return;
		}

		const previousTools = new Map(previous.tools.map((tool) => [tool.toolId, tool]));
		for (const tool of next.tools) {
			const previousTool = previousTools.get(tool.toolId);
			if (previousTool && !previousTool.done && tool.done) {
				this.messageTarget.postMessage({
					type: 'agentToolDone',
					id: next.visualId,
					toolId: tool.toolId,
				});
			}
		}
	}

	private emitSubagentChanges(previous: AgentPresentation, next: AgentPresentation): void {
		if (!this.messageTarget) {
			return;
		}

		const previousSubagents = new Map(previous.subagents.map((subagent) => [subagent.parentToolId, subagent]));
		for (const subagent of next.subagents) {
			const previousSubagent = previousSubagents.get(subagent.parentToolId);
			const previousTools = new Map(previousSubagent?.tools.map((tool) => [tool.toolId, tool]) ?? []);
			for (const tool of subagent.tools) {
				if (!previousTools.has(tool.toolId)) {
					this.messageTarget.postMessage({
						type: 'subagentToolStart',
						id: next.visualId,
						parentToolId: subagent.parentToolId,
						status: tool.status,
						toolId: tool.toolId,
					});
				}
				const previousTool = previousTools.get(tool.toolId);
				if (previousTool && !previousTool.done && tool.done) {
					this.messageTarget.postMessage({
						type: 'subagentToolDone',
						id: next.visualId,
						parentToolId: subagent.parentToolId,
						toolId: tool.toolId,
					});
				}
			}
		}
	}

	private findBestObservationForVisualId(visualId: number, capability: keyof NonNullable<AgentPresentation['capabilities']>): ObservationRecord | undefined {
		const group = [...this.groups.values()].find((candidate) => candidate.visualId === visualId);
		if (!group) {
			return undefined;
		}

		return [...group.observationKeys]
			.map((observationKey) => this.observations.get(observationKey))
			.filter((observation): observation is ObservationRecord => Boolean(observation))
			.filter((observation) => observation.snapshot.capabilities?.[capability])
			.sort(compareObservations)[0];
	}

	private pruneStaleObservations(): void {
		const now = Date.now();
		for (const [observationKey, observation] of [...this.observations]) {
			if (observation.missingSince === null) {
				continue;
			}
			if (now - observation.missingSince < AGENT_STALE_GRACE_MS) {
				continue;
			}
			this.deleteObservation(observationKey);
		}
	}

	private deleteObservation(observationKey: string): void {
		const observation = this.observations.get(observationKey);
		if (!observation) {
			return;
		}

		const group = this.groups.get(observation.groupId);
		if (group) {
			group.observationKeys.delete(observationKey);
			this.rebuildGroupIdentityIndex(group);
		}
		this.observations.delete(observationKey);
		this.logger.debug('Removed stale agent observation', {
			groupId: observation.groupId,
			observationKey,
		});
		this.recomputeGroup(observation.groupId);
	}

	private recomputeGroup(groupId: string): void {
		const group = this.groups.get(groupId);
		if (!group) {
			return;
		}

		const snapshots = [...group.observationKeys]
			.map((observationKey) => this.observations.get(observationKey))
			.filter((observation): observation is ObservationRecord => Boolean(observation))
			.map((observation) => observation.snapshot);

		if (snapshots.length === 0) {
			this.cleanupEmptyGroup(groupId);
			return;
		}

		if (group.visualId === undefined) {
			group.visualId = this.allocateVisualId(snapshots.map((snapshot) => snapshot.preferredVisualId));
			this.logger.debug('Assigned visual agent id', {
				groupId,
				visualId: group.visualId,
			});
		}

		const nextPresentation = buildPresentation(group.visualId, snapshots);
		const previousPresentation = group.presentation;
		group.presentation = nextPresentation;
		this.rebuildGroupIdentityIndex(group);

		if (!this.webviewReady || !this.messageTarget) {
			return;
		}

		if (!previousPresentation) {
			this.messageTarget.postMessage({
				type: 'agentCreated',
				capabilities: nextPresentation.capabilities,
				folderName: nextPresentation.folderName,
				id: nextPresentation.visualId,
			});
			this.logger.debug('Spawned visual agent', {
				groupId,
				visualId: nextPresentation.visualId,
			});
			this.emitFullPresentation(nextPresentation);
			return;
		}

		this.emitPresentationDiff(previousPresentation, nextPresentation);
	}

	private cleanupEmptyGroup(groupId: string): void {
		const group = this.groups.get(groupId);
		if (!group) {
			return;
		}

		for (const identityKey of group.identityKeys) {
			if (this.groupIdByIdentityKey.get(identityKey) === group.id) {
				this.groupIdByIdentityKey.delete(identityKey);
			}
		}

		if (group.presentation && this.webviewReady && this.messageTarget) {
			this.messageTarget.postMessage({
				type: 'agentClosed',
				id: group.presentation.visualId,
			});
			this.logger.debug('Despawned visual agent', {
				groupId,
				visualId: group.presentation.visualId,
			});
		}

		this.groups.delete(groupId);
	}

	private resolveTargetGroup(groupIds: string[], reusableEmptyGroup: GroupRecord | undefined): GroupRecord {
		if (groupIds.length === 0) {
			return reusableEmptyGroup ?? this.createGroup();
		}

		if (groupIds.length === 1) {
			return this.groups.get(groupIds[0]) ?? reusableEmptyGroup ?? this.createGroup();
		}

		const groups = groupIds
			.map((groupId) => this.groups.get(groupId))
			.filter((group): group is GroupRecord => Boolean(group))
			.sort((left, right) => (left.visualId ?? Number.MAX_SAFE_INTEGER) - (right.visualId ?? Number.MAX_SAFE_INTEGER));

		const primary = groups[0] ?? reusableEmptyGroup ?? this.createGroup();
		for (const secondary of groups.slice(1)) {
			this.logger.debug('Merged agent groups for dedupe', {
				primaryGroupId: primary.id,
				secondaryGroupId: secondary.id,
			});
			for (const observationKey of secondary.observationKeys) {
				const observation = this.observations.get(observationKey);
				if (observation) {
					observation.groupId = primary.id;
				}
				primary.observationKeys.add(observationKey);
			}
			secondary.observationKeys.clear();
			this.cleanupEmptyGroup(secondary.id);
		}

		this.rebuildGroupIdentityIndex(primary);
		return primary;
	}

	private createGroup(): GroupRecord {
		const group: GroupRecord = {
			id: randomUUID(),
			identityKeys: new Set<string>(),
			observationKeys: new Set<string>(),
			presentation: undefined,
			visualId: undefined,
		};
		this.groups.set(group.id, group);
		return group;
	}

	private rebuildGroupIdentityIndex(group: GroupRecord): void {
		for (const identityKey of group.identityKeys) {
			if (this.groupIdByIdentityKey.get(identityKey) === group.id) {
				this.groupIdByIdentityKey.delete(identityKey);
			}
		}

		group.identityKeys.clear();
		for (const observationKey of group.observationKeys) {
			const observation = this.observations.get(observationKey);
			if (!observation) {
				continue;
			}
			for (const identityKey of observation.snapshot.identityKeys) {
				group.identityKeys.add(identityKey);
				this.groupIdByIdentityKey.set(identityKey, group.id);
			}
		}
	}

	private allocateVisualId(preferredIds: Array<number | undefined>): number {
		for (const preferredId of preferredIds) {
			if (preferredId === undefined || preferredId <= 0 || this.isVisualIdInUse(preferredId)) {
				continue;
			}
			if (preferredId >= this.nextVisualId) {
				this.nextVisualId = preferredId + 1;
			}
			return preferredId;
		}

		while (this.isVisualIdInUse(this.nextVisualId)) {
			this.nextVisualId += 1;
		}
		return this.nextVisualId++;
	}

	private isVisualIdInUse(visualId: number): boolean {
		for (const group of this.groups.values()) {
			if (group.visualId === visualId) {
				return true;
			}
		}
		return false;
	}

	private getObservationKey(providerId: string, providerSessionId: string): string {
		return `${providerId}:${providerSessionId}`;
	}
}

function normalizeObservation(snapshot: AgentObservation): AgentObservation {
	const identityKeys = snapshot.identityKeys.length > 0
		? [...new Set(snapshot.identityKeys.filter(Boolean))]
		: [`${snapshot.providerId}:${snapshot.providerSessionId}`];

	return {
		...snapshot,
		capabilities: {
			closable: snapshot.capabilities?.closable ?? false,
			focusable: snapshot.capabilities?.focusable ?? false,
		},
		identityKeys,
		subagents: snapshot.subagents.map((subagent) => ({
			...subagent,
			tools: [...subagent.tools],
		})),
		tools: [...snapshot.tools],
	};
}

function compareObservations(left: { snapshot: AgentObservation }, right: { snapshot: AgentObservation }): number {
	return compareObservationSnapshots(left.snapshot, right.snapshot);
}

function compareObservationSnapshots(left: AgentObservation, right: AgentObservation): number {
	const priorityDelta = right.priority - left.priority;
	if (priorityDelta !== 0) {
		return priorityDelta;
	}

	const richnessDelta = scoreObservationRichness(right) - scoreObservationRichness(left);
	if (richnessDelta !== 0) {
		return richnessDelta;
	}

	const focusableDelta = Number(Boolean(right.capabilities?.focusable)) - Number(Boolean(left.capabilities?.focusable));
	if (focusableDelta !== 0) {
		return focusableDelta;
	}

	return 0;
}

function scoreObservationRichness(snapshot: AgentObservation): number {
	return snapshot.tools.length * 10
		+ snapshot.subagents.reduce((count, subagent) => count + subagent.tools.length, 0) * 5
		+ Number(Boolean(snapshot.metadata?.jsonlFile)) * 3
		+ Number(snapshot.state !== 'unknown');
}

function buildPresentation(visualId: number, snapshots: AgentObservation[]): AgentPresentation {
	const sortedSnapshots = [...snapshots].sort(compareObservationSnapshots);
	const primary = sortedSnapshots[0];
	const capabilities = {
		closable: sortedSnapshots.some((snapshot) => snapshot.capabilities?.closable),
		focusable: sortedSnapshots.some((snapshot) => snapshot.capabilities?.focusable),
	};

	return {
		capabilities,
		folderName: primary.metadata?.folderName,
		framework: primary.framework,
		source: primary.source,
		state: primary.state,
		subagents: primary.subagents.map((subagent) => ({
			...subagent,
			tools: [...subagent.tools],
		})),
		tools: primary.tools.map((tool) => ({ ...tool })),
		visualId,
	};
}

function hasStructuralRemoval(previous: AgentPresentation, next: AgentPresentation): boolean {
	const nextToolIds = new Set(next.tools.map((tool) => tool.toolId));
	for (const tool of previous.tools) {
		if (!nextToolIds.has(tool.toolId)) {
			return true;
		}
	}

	const nextSubagents = new Map(next.subagents.map((subagent) => [subagent.parentToolId, subagent]));
	for (const previousSubagent of previous.subagents) {
		const nextSubagent = nextSubagents.get(previousSubagent.parentToolId);
		if (!nextSubagent) {
			return true;
		}
		const nextSubToolIds = new Set(nextSubagent.tools.map((tool) => tool.toolId));
		for (const tool of previousSubagent.tools) {
			if (!nextSubToolIds.has(tool.toolId)) {
				return true;
			}
		}
	}

	return false;
}

function hasPermissionWait(presentation: AgentPresentation): boolean {
	return presentation.tools.some((tool) => tool.permissionWait && !tool.done)
		|| presentation.subagents.some((subagent) => subagent.tools.some((tool) => tool.permissionWait && !tool.done));
}

function getPermissionParentToolIds(presentation: AgentPresentation): Set<string> {
	const parentToolIds = new Set<string>();
	for (const subagent of presentation.subagents) {
		if (subagent.tools.some((tool) => tool.permissionWait && !tool.done)) {
			parentToolIds.add(subagent.parentToolId);
		}
	}
	return parentToolIds;
}
