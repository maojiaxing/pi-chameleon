import { createProvider, envApiKeyAuth, type Api, type FetchFunction, type Model, type Provider } from "@earendil-works/pi-ai";
import { claudeCodeStream, claudeCodeStreamSimple } from "../claude/stream.ts";
import { codexStream, codexStreamSimple } from "../codex/stream.ts";
import { buildModels, fetchCatalog } from "./catalog.ts";
import type { ChameleonProviderId, DiscoveryAccess, DiscoveryClock, RelayFamily, SnapshotRepository, SnapshotState } from "./types.ts";

export interface DiscoveryState {
	provider: ChameleonProviderId;
	status: "unconfigured" | "cache" | "empty" | "loading" | "success" | "failed" | "unsaved";
	checkedAt?: number;
}
export interface DiscoveryProviderDependencies {
	repository: SnapshotRepository;
	fetch?: FetchFunction;
	clock?: DiscoveryClock;
	resolveAccess(): Promise<DiscoveryAccess | undefined>;
	onChange?(state: DiscoveryState): void;
}

/** Canonicalize the actual HTTP header result, including case folding and null deletions. */
function canonicalAccess(access: DiscoveryAccess): DiscoveryAccess {
	const headers = new Headers();
	for (const [name, value] of Object.entries(access.headers ?? {})) {
		if (value == null) headers.delete(name);
		else headers.set(name, value);
	}
	return { baseUrl: access.baseUrl, apiKey: access.apiKey, headers: Object.fromEntries(headers.entries()) };
}

/** Native catalog policy. Pi still owns auth, model configuration and stream dispatch. */
export function createDiscoveryProvider(family: RelayFamily, deps: DiscoveryProviderDependencies): {
	provider: Provider;
	dispose(): void;
} {
	const id: ChameleonProviderId = `chameleon-${family}`;
	let models: readonly Model<Api>[] = [];
	let identity: string | undefined;
	let saved: SnapshotState = { suspended: false };
	let disposed = false;
	const base = createProvider({
		id, name: family === "claude" ? "Chameleon Claude (Claude Code disguise)" : "Chameleon Codex (Codex CLI disguise)",
		auth: { apiKey: envApiKeyAuth("Relay API key", []) }, models: [],
		api: family === "claude"
			? { stream: claudeCodeStream, streamSimple: claudeCodeStreamSimple }
			: { stream: codexStream, streamSimple: codexStreamSimple },
	});
	const provider: Provider = {
		...base, getModels: () => models, getAllModels: () => models,
		async refreshModels(context) {
			const current = () => !disposed && !context.signal.aborted;
			try {
				const resolved = await deps.resolveAccess();
				if (!current()) return;
				if (!resolved) {
					await context.publish({ update: () => { identity = undefined; saved = { suspended: false }; models = []; } });
					if (current()) deps.onChange?.({ provider: id, status: "unconfigured" });
					return;
				}
				const access = canonicalAccess(resolved);
				const nextIdentity = await deps.repository.identity(access);
				if (!current()) return;
				const next = identity === nextIdentity ? saved : await deps.repository.read(id, nextIdentity, { signal: context.signal, isCurrent: current });
				if (!current()) return;
				const nextModels = next.suspended || !next.snapshot ? [] : buildModels(family, access.baseUrl, next.snapshot.records);
				const published = await context.publish({ update: () => { identity = nextIdentity; saved = next; models = nextModels; } });
				if (published && current()) deps.onChange?.({ provider: id, status: next.snapshot ? "cache" : "empty", checkedAt: next.snapshot?.checkedAt });
				if (!published || !current() || !context.allowNetwork) return;
				deps.onChange?.({ provider: id, status: "loading", checkedAt: next.snapshot?.checkedAt });
				const records = await fetchCatalog(family, access, { fetch: deps.fetch ?? globalThis.fetch, clock: deps.clock, signal: context.signal });
				if (!current()) return;
				const snapshot = { checkedAt: deps.clock?.now() ?? Date.now(), records };
				const discovered = buildModels(family, access.baseUrl, records);
				if (!await context.publish({ update: () => { saved = { snapshot, suspended: false }; models = discovered; } }) || !current()) return;
				try {
					await deps.repository.saveSuccess(id, nextIdentity, snapshot, { signal: context.signal, isCurrent: current });
					if (current()) deps.onChange?.({ provider: id, status: records.length ? "success" : "empty", checkedAt: snapshot.checkedAt });
				} catch {
					if (current()) deps.onChange?.({ provider: id, status: "unsaved", checkedAt: snapshot.checkedAt });
				}
			} catch {
				if (current()) deps.onChange?.({ provider: id, status: "failed" });
			}
		},
	};
	return { provider, dispose() { disposed = true; models = []; identity = undefined; saved = { suspended: false }; } };
}
