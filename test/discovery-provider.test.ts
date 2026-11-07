import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, type FetchFunction } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createDiscoveryProvider } from "../src/discovery/provider.ts";
import { createSnapshotRepository } from "../src/discovery/snapshot.ts";
import type { DiscoveryAccess, DiscoveryClock, RelayFamily, SnapshotRepository } from "../src/discovery/types.ts";

const codexId = "chameleon-codex";
const config = { baseUrl: "https://relay.example.test/gateway/v1", apiKey: "synthetic-list-key", authHeader: true };
function network(...responses: (unknown | Response | Error)[]) {
	const requests: { url: string; init: RequestInit; headers: Headers }[] = [];
	const fetch: FetchFunction = async (input, init = {}) => {
		requests.push({ url: String(input), init, headers: new Headers(init.headers) });
		assert.ok(responses.length, "unexpected discovery request");
		const response = responses.shift();
		if (response instanceof Error) throw response;
		return response instanceof Response ? response : Response.json(response);
	};
	return { fetch, requests };
}
function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}
function clock(start = 1_000) {
	let now = start;
	const timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback(): void }>();
	let nextTimer = 0;
	const value: DiscoveryClock = {
		now: () => now,
		setTimeout(callback, milliseconds) {
			const handle = ++nextTimer as unknown as ReturnType<typeof setTimeout>;
			timers.set(handle, { at: now + milliseconds, callback });
			return handle;
		},
		clearTimeout(handle) { timers.delete(handle); },
	};
	return { value, advance(milliseconds: number) {
		now += milliseconds;
		for (const [handle, timer] of timers) if (timer.at <= now) { timers.delete(handle); timer.callback(); }
	} };
}

async function withRuntime(
	fetch: FetchFunction,
	run: (h: {
		runtime: ModelRuntime; registry: ModelRegistry; path: string; repository: SnapshotRepository;
		credentials: InMemoryCredentialStore; bind(): void; states: string[];
	}) => Promise<void>,
	options: { family?: RelayFamily; providerConfig?: unknown; repository?: SnapshotRepository; clock?: DiscoveryClock } = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-discovery-provider-"));
	const family = options.family ?? "codex";
	const id = `chameleon-${family}`;
	const credentials = new InMemoryCredentialStore();
	const repository = options.repository ?? createSnapshotRepository({ directory: join(directory, "cache") });
	const initialized = deferred<void>();
	const states: string[] = [];
	let resolveAccess: (() => Promise<DiscoveryAccess | undefined>) | undefined;
	const discovery = createDiscoveryProvider(family, {
		fetch, repository, clock: options.clock,
		resolveAccess: () => resolveAccess?.() ?? Promise.resolve(undefined),
		onChange: (state) => { states.push(state.status); if (state.status === "unconfigured") initialized.resolve(); },
	});
	try {
		const path = join(directory, "models.json");
		await writeFile(path, JSON.stringify({ providers: { [id]: options.providerConfig ?? config } }));
		const runtime = await ModelRuntime.create({
			credentials, modelsPath: path, modelsStore: new InMemoryModelsStore(),
			refreshOnCreate: false, allowModelNetwork: false,
		});
		runtime.registerNativeProvider(discovery.provider);
		// Native registration launches a public cache-only refresh. Bind only after that phase.
		await initialized.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		const registry = new ModelRegistry(runtime);
		await run({ runtime, registry, path, repository, credentials, states, bind() {
			resolveAccess = async () => {
				const resolved = await registry.getProviderAuth(id);
				return resolved ? {
					baseUrl: resolved.auth.baseUrl ?? registry.getProvider(id)?.baseUrl ?? "",
					apiKey: resolved.auth.apiKey, headers: resolved.auth.headers,
				} : undefined;
			};
		} });
	} finally {
		discovery.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

test("native discovery starts empty and does not restore an unconfirmed identity or make cache-only requests", async () => {
	const net = network();
	await withRuntime(net.fetch, async ({ runtime, registry, repository, bind }) => {
		const identity = await repository.identity({ baseUrl: config.baseUrl, apiKey: config.apiKey });
		await repository.saveSuccess(codexId, identity, { checkedAt: 1, records: [{ id: "GPT-saved" }] });
		assert.deepEqual(runtime.getModels(codexId), []);
		await registry.refresh({ providers: [codexId], allowNetwork: false });
		assert.deepEqual(runtime.getModels(codexId), []);
		const auth = await registry.getProviderAuth(codexId);
		assert.equal(auth?.auth.apiKey, "synthetic-list-key");
		assert.equal(new Headers(auth?.auth.headers as HeadersInit).get("authorization"), "Bearer synthetic-list-key");
		bind();
		await registry.refresh({ providers: [codexId], allowNetwork: false });
		assert.equal(net.requests.length, 0);
	}, { providerConfig: config });
});

test("a successful empty catalog replaces the one automatic snapshot while ordinary failures retain it and explicit models", async () => {
	const net = network({ data: [{ id: "gpt-first" }, { id: "gpt-removed" }] }, new Error("transport synthetic-list-key"), { data: [] });
	await withRuntime(net.fetch, async ({ runtime, registry, repository, bind, states }) => {
		bind();
		const refresh = () => registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
		await refresh();
		await refresh();
		assert.deepEqual(runtime.getModels(codexId).map((m) => m.id), ["gpt-first", "gpt-removed", "explicit-only"]);
		assert.ok(states.includes("failed"));
		await refresh();
		assert.deepEqual(runtime.getModels(codexId).map((m) => m.id), ["explicit-only"]);
		const identity = await repository.identity({ baseUrl: config.baseUrl, apiKey: config.apiKey, headers: { authorization: "Bearer synthetic-list-key" } });
		assert.deepEqual((await repository.read(codexId, identity)).snapshot?.records, []);
		assert.equal(states.at(-1), "empty");
	}, { providerConfig: { ...config, models: [{ id: "explicit-only", api: "openai-responses", name: "User choice", reasoning: false }] } });
});

test("list permission failure suspends automatic candidates across restart until a complete success without deleting explicit models", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-suspended-restart-"));
	const repository = createSnapshotRepository({ directory });
	const providerConfig = { ...config, models: [{ id: "explicit-only", api: "openai-responses", name: "User choice", reasoning: false }] };
	try {
		await withRuntime(network({ data: [{ id: "gpt-permitted" }] }, new Response("synthetic-list-key not allowed", { status: 403 })).fetch,
			async ({ registry, runtime, bind, states }) => {
				bind();
				await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
				await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
				assert.deepEqual(runtime.getModels(codexId).map((m) => m.id), ["explicit-only"]);
				assert.equal(states.at(-1), "suspended");
			}, { repository, providerConfig });
		await withRuntime(network(new Error("offline"), { data: [{ id: "gpt-restored" }] }).fetch,
			async ({ registry, runtime, bind }) => {
				bind();
				await registry.refresh({ providers: [codexId], allowNetwork: false });
				assert.deepEqual(runtime.getModels(codexId).map((m) => m.id), ["explicit-only"]);
				await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
				assert.deepEqual(runtime.getModels(codexId).map((m) => m.id), ["explicit-only"]);
				await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
				assert.deepEqual(runtime.getModels(codexId).map((m) => m.id), ["gpt-restored", "explicit-only"]);
			}, { repository, providerConfig });
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("a successful discovery with failed persistence remains the latest in-memory catalog and restart uses the intact old success", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-failed-save-"));
	let failWrites = false;
	const repository = createSnapshotRepository({ directory, io: { async rename(from, to) {
		if (failWrites) throw new Error("storage synthetic-list-key");
		await rename(from, to);
	} } });
	try {
		await withRuntime(network({ data: [{ id: "gpt-old" }] }, { data: [{ id: "gpt-new" }] }).fetch,
			async ({ registry, runtime, bind, states }) => {
				bind();
				await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
				failWrites = true;
				await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
				assert.deepEqual(runtime.getModels(codexId).map((m) => m.id), ["gpt-new"]);
				assert.equal(states.at(-1), "unsaved");
				await registry.refresh({ providers: [codexId], allowNetwork: false });
				assert.deepEqual(runtime.getModels(codexId).map((m) => m.id), ["gpt-new"]);
			}, { repository });
		await withRuntime(network().fetch, async ({ bind, registry, runtime }) => {
			bind();
			await registry.refresh({ providers: [codexId], allowNetwork: false });
			assert.deepEqual(runtime.getModels(codexId).map((m) => m.id), ["gpt-old"]);
		}, { repository: createSnapshotRepository({ directory }) });
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("changing effective credentials or losing configuration clears automatic candidates without a network fallback", async () => {
	const net = network({ data: [{ id: "gpt-old-identity" }] });
	await withRuntime(net.fetch, async ({ bind, registry, runtime, path, credentials }) => {
		bind();
		await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
		await credentials.modify(codexId, async () => ({ type: "api_key", key: "synthetic-other-key" }));
		await registry.refresh({ providers: [codexId], allowNetwork: false });
		assert.deepEqual(runtime.getModels(codexId), []);
		await credentials.delete(codexId);
		await writeFile(path, JSON.stringify({ providers: { [codexId]: { baseUrl: config.baseUrl } } }));
		await registry.refresh({ providers: [codexId], allowNetwork: false });
		assert.deepEqual(runtime.getModels(codexId), []);
		assert.equal(net.requests.length, 1);
	});
});

test("ordinary model refresh obeys the one-hour successful freshness gate and force bypasses it including empty success", async () => {
	const time = clock();
	const net = network({ data: [{ id: "gpt-first" }] }, { data: [] }, { data: [{ id: "gpt-forced" }] });
	await withRuntime(net.fetch, async ({ bind, registry, runtime }) => {
		bind();
		await registry.refresh({ providers: [codexId], allowNetwork: true });
		time.advance(3_599_999);
		await registry.refresh({ providers: [codexId], allowNetwork: true });
		assert.equal(net.requests.length, 1);
		time.advance(1);
		await registry.refresh({ providers: [codexId], allowNetwork: true });
		assert.deepEqual(runtime.getModels(codexId), []);
		await registry.refresh({ providers: [codexId], allowNetwork: true });
		assert.equal(net.requests.length, 2);
		await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
		assert.deepEqual(runtime.getModels(codexId).map((m) => m.id), ["gpt-forced"]);
	}, { clock: time.value });
});

test("ordinary native refreshes share one in-flight request even when Pi supersedes and aborts the old waiter", async () => {
	const started = deferred<void>();
	const release = deferred<Response>();
	let requests = 0;
	let requestSignal: AbortSignal | undefined;
	const fetch: FetchFunction = async (_url, init) => {
		requests++;
		requestSignal = init?.signal ?? undefined;
		started.resolve();
		return release.promise;
	};
	await withRuntime(fetch, async ({ bind, registry, runtime }) => {
		bind();
		const first = registry.refresh({ providers: [codexId], allowNetwork: true });
		await started.promise;
		const second = registry.refresh({ providers: [codexId], allowNetwork: true });
		await first;
		assert.equal(requestSignal?.aborted, false, "an old native waiter must not cancel the shared transport");
		release.resolve(Response.json({ data: [{ id: "gpt-shared" }] }));
		await second;
		assert.equal(requests, 1, "ordinary refresh is a single shared network operation");
		assert.deepEqual(runtime.getModels(codexId).map((m) => m.id), ["gpt-shared"]);
	});
});

test("force and a changed identity abort the old job and late results cannot overwrite memory or the restart snapshot", async () => {
	const started = deferred<void>();
	const oldRelease = deferred<Response>();
	const requests: { headers: Headers; signal?: AbortSignal }[] = [];
	const fetch: FetchFunction = async (_input, init) => {
		requests.push({ headers: new Headers(init?.headers), signal: init?.signal ?? undefined });
		if (requests.length === 1) { started.resolve(); return oldRelease.promise; }
		return Response.json({ data: [{ id: "gpt-latest-identity" }] });
	};
	await withRuntime(fetch, async ({ registry, runtime, bind, path, repository }) => {
		bind();
		const old = registry.refresh({ providers: [codexId], allowNetwork: true });
		await started.promise;
		await writeFile(path, JSON.stringify({ providers: { [codexId]: { ...config, apiKey: "synthetic-new-access" } } }));
		await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
		assert.equal(requests[0].signal?.aborted, true);
		assert.equal(requests[1].headers.get("authorization"), "Bearer synthetic-new-access");
		oldRelease.resolve(Response.json({ data: [{ id: "gpt-obsolete" }] }));
		await old;
		assert.deepEqual(runtime.getModels(codexId).map((m) => m.id), ["gpt-latest-identity"]);
		const identity = await repository.identity({ baseUrl: config.baseUrl, apiKey: "synthetic-new-access", headers: { authorization: "Bearer synthetic-new-access" } });
		assert.deepEqual((await repository.read(codexId, identity)).snapshot?.records, [{ id: "gpt-latest-identity" }]);
	});
});

test("the catalog has a 15-second total budget even when a fetch ignores cancellation and a late body is never published", async () => {
	const time = clock();
	const started = deferred<void>();
	const release = deferred<Response>();
	let signal: AbortSignal | undefined;
	const fetch: FetchFunction = async (_input, init) => { signal = init?.signal ?? undefined; started.resolve(); return release.promise; };
	await withRuntime(fetch, async ({ bind, registry, runtime, states }) => {
		bind();
		const refreshing = registry.refresh({ providers: [codexId], allowNetwork: true });
		await started.promise;
		time.advance(15_000);
		await refreshing;
		assert.equal(signal?.aborted, true);
		assert.equal(states.at(-1), "failed");
		release.resolve(Response.json({ data: [{ id: "gpt-too-late" }] }));
		await registry.refresh({ providers: [codexId], allowNetwork: false });
		assert.deepEqual(runtime.getModels(codexId), []);
	}, { clock: time.value });
});

test("a complete discovered catalog is native-composed with user models and overrides and restores only API facts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-discovery-restart-"));
	const repository = createSnapshotRepository({ directory });
	const net = network({ data: [{ id: "gpt-future" }, { id: "gpt-5.3-codex" }] });
	const providerConfig = {
		...config,
		models: [{ id: "private-chat", api: "openai-responses", name: "Explicit private chat", reasoning: false, input: ["text"],
			contextWindow: 7_000, maxTokens: 1_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		modelOverrides: { "gpt-future": { contextWindow: 9_000, maxTokens: 900, reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
	};
	try {
		await withRuntime(net.fetch, async ({ runtime, registry, bind }) => {
			bind();
			await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
			assert.deepEqual(runtime.getModels(codexId).map((model) => model.id), ["gpt-future", "gpt-5.3-codex", "private-chat"]);
			assert.equal(registry.find(codexId, "gpt-future")?.contextWindow, 9_000);
			assert.equal(registry.find(codexId, "gpt-future")?.maxTokens, 900);
			assert.equal(net.requests[0].url, "https://relay.example.test/gateway/v1/models");
			assert.equal(net.requests[0].headers.get("authorization"), "Bearer synthetic-list-key");
			assert.equal(net.requests[0].init.method, "GET");
			assert.equal(net.requests[0].init.body, undefined);
			const resolved = await registry.getProviderAuth(codexId);
			assert.ok(resolved);
			const identity = await repository.identity({ baseUrl: config.baseUrl, apiKey: resolved.auth.apiKey, headers: { authorization: "Bearer synthetic-list-key" } });
			assert.deepEqual((await repository.read(codexId, identity)).snapshot?.records, [{ id: "gpt-future" }, { id: "gpt-5.3-codex" }]);
		}, { repository, providerConfig });
		await withRuntime(network().fetch, async ({ registry, runtime, bind }) => {
			bind();
			await registry.refresh({ providers: [codexId], allowNetwork: false });
			assert.deepEqual(runtime.getModels(codexId).map((model) => model.id), ["gpt-future", "gpt-5.3-codex"]);
			assert.equal(registry.find(codexId, "gpt-future")?.contextWindow, 32_768);
			assert.match(registry.find(codexId, "gpt-future")!.name, /能力未确认.*费用未知.*不代表免费/);
			assert.match(registry.find(codexId, "gpt-5.3-codex")!.name, /参考费用/);
		}, { repository });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
