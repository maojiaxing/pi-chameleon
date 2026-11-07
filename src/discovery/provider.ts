import {
	createProvider, envApiKeyAuth, type Api, type FetchFunction, type Model, type Provider, type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { claudeCodeStream, claudeCodeStreamSimple } from "../claude/stream.ts";
import { codexStream, codexStreamSimple } from "../codex/stream.ts";
import { buildModels, CatalogFetchError, fetchCatalog } from "./catalog.ts";
import type { CatalogSnapshot, ChameleonProviderId, DiscoveryAccess, DiscoveryClock, RelayFamily, SnapshotRepository, SnapshotState } from "./types.ts";

export interface DiscoveryState {
	provider: ChameleonProviderId;
	status: "unconfigured" | "cache" | "empty" | "loading" | "success" | "failed" | "unsaved" | "suspended" | "suspension-unsaved";
	checkedAt?: number;
}
export interface DiscoveryProviderDependencies {
	repository: SnapshotRepository;
	fetch?: FetchFunction;
	clock?: DiscoveryClock;
	resolveAccess(): Promise<DiscoveryAccess | undefined>;
	onChange?(state: DiscoveryState): void;
}

/** Canonicalize actual HTTP headers, including case folding and null deletions. */
function canonicalAccess(access: DiscoveryAccess): DiscoveryAccess {
	const headers = new Headers();
	for (const [name, value] of Object.entries(access.headers ?? {})) {
		if (value == null) headers.delete(name);
		else headers.set(name, value);
	}
	return { baseUrl: access.baseUrl, apiKey: access.apiKey, headers: Object.fromEntries(headers.entries()) };
}
interface CatalogJob {
	identity: string;
	revision: number;
	controller: AbortController;
	result: Promise<CatalogSnapshot>;
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
	let unsaved = false;
	let disposed = false;
	let revision = 0;
	let job: CatalogJob | undefined;
	let latest: RefreshModelsContext | undefined;
	const now = () => deps.clock?.now() ?? Date.now();
	const emit = (status: DiscoveryState["status"]) => deps.onChange?.({ provider: id, status, checkedAt: saved.snapshot?.checkedAt });
	function cancelJob() { revision++; job?.controller.abort(); job = undefined; }
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
			if (disposed || context.signal.aborted) return;
			latest = context;
			const current = () => !disposed && latest === context && !context.signal.aborted;
			let ownedJob: CatalogJob | undefined;
			try {
				const resolved = await deps.resolveAccess();
				if (!current()) return;
				if (!resolved) {
					cancelJob();
					if (await context.publish({ update: () => { identity = undefined; saved = { suspended: false }; models = []; unsaved = false; } }) && current()) emit("unconfigured");
					return;
				}
				const access = canonicalAccess(resolved);
				const nextIdentity = await deps.repository.identity(access);
				if (!current()) return;
				if (identity !== nextIdentity) {
					cancelJob();
					// Clear the previous access boundary before any asynchronous disk restore.
					if (!await context.publish({ update: () => { identity = nextIdentity; saved = { suspended: false }; models = []; unsaved = false; } })) return;
					const restored = await deps.repository.read(id, nextIdentity, { signal: context.signal, isCurrent: current });
					if (!current()) return;
					if (!await context.publish({ update: () => { saved = restored; models = restored.suspended || !restored.snapshot ? [] : buildModels(family, access.baseUrl, restored.snapshot.records); } })) return;
				}
				if (!current()) return;
				// Never reload a same-identity disk copy over a newer in-memory success.
				emit(saved.suspended ? "suspended" : unsaved ? "unsaved" : saved.snapshot ? "cache" : "empty");
				if (process.env.PI_OFFLINE !== undefined) return;
				// Cache-only never initiates network, but its newest native context can publish an existing job.
				if (!context.allowNetwork && !job) return;
				if (!context.force && !job && !saved.suspended && saved.snapshot && now() - saved.snapshot.checkedAt < 3_600_000) return;
				if (context.force) cancelJob();
				if (!job) {
					const controller = new AbortController();
					const result = fetchCatalog(family, access, { fetch: deps.fetch ?? globalThis.fetch, clock: deps.clock, signal: controller.signal })
						.then((records) => ({ checkedAt: now(), records }));
					job = { identity: nextIdentity, revision, controller, result };
				}
				ownedJob = job;
				const active = () => current() && job === ownedJob && revision === ownedJob!.revision && identity === ownedJob!.identity && !ownedJob!.controller.signal.aborted;
				emit("loading");
				const snapshot = await ownedJob.result;
				if (!active()) return;
				if (!await context.publish({ update: () => { saved = { snapshot, suspended: false }; models = buildModels(family, access.baseUrl, snapshot.records); unsaved = true; } }) || !active()) return;
				try {
					await deps.repository.saveSuccess(id, nextIdentity, snapshot, { signal: ownedJob.controller.signal, isCurrent: active });
					if (active()) { unsaved = false; emit(snapshot.records.length ? "success" : "empty"); }
				} catch {
					if (active()) emit("unsaved");
				}
			} catch (error) {
				if (!current() || (ownedJob && (job !== ownedJob || revision !== ownedJob.revision))) return;
				if (error instanceof CatalogFetchError && (error.httpStatus === 401 || error.httpStatus === 403)) {
					if (!await context.publish({ update: () => { saved = { ...saved, suspended: true }; models = []; } }) || !current()) return;
					let status: DiscoveryState["status"] = "suspended";
					try { if (identity) await deps.repository.suspend(id, identity, { signal: context.signal, isCurrent: current }); }
					catch { status = "suspension-unsaved"; }
					if (current()) emit(status);
				} else emit("failed");
			} finally {
				// A superseded waiter cannot release a job the latest waiter is about to join.
				if (ownedJob && job === ownedJob && (current() || !latest || latest.signal.aborted)) job = undefined;
			}
		},
	};
	return { provider, dispose() { disposed = true; latest = undefined; cancelJob(); models = []; identity = undefined; saved = { suspended: false }; } };
}
