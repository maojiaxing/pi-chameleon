import type { Api, Model, ProviderHeaders, ThinkingLevelMap } from "@earendil-works/pi-ai";

/** Discovery owns catalog membership; Pi owns user configuration and request credentials. */
export type RelayFamily = "claude" | "codex";
export type ChameleonProviderId = "chameleon-claude" | "chameleon-codex";

export interface DiscoveryAccess {
	baseUrl: string;
	apiKey?: string;
	headers?: ProviderHeaders;
}

/** Allowlisted discovery facts only: no raw response, upstream identity, headers or credentials. */
export interface CatalogRecord {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: Model<Api>["input"];
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: Model<Api>["compat"];
	cost?: Model<Api>["cost"];
}

export interface CatalogSnapshot {
	checkedAt: number;
	records: readonly CatalogRecord[];
}

export interface SnapshotState {
	snapshot?: CatalogSnapshot;
	suspended: boolean;
}

export interface OperationGuard {
	signal?: AbortSignal;
	isCurrent?: () => boolean;
}

/** This dependency is the storage seam; implementations must never persist DiscoveryAccess. */
export interface SnapshotRepository {
	identity(access: DiscoveryAccess): Promise<string>;
	read(provider: ChameleonProviderId, identity: string, guard?: OperationGuard): Promise<SnapshotState>;
	saveSuccess(provider: ChameleonProviderId, identity: string, snapshot: CatalogSnapshot, guard?: OperationGuard): Promise<void>;
	suspend(provider: ChameleonProviderId, identity: string, guard?: OperationGuard): Promise<void>;
}

export interface DiscoveryClock {
	now(): number;
	setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
	clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}
