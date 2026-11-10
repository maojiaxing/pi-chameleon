import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, type FetchFunction, type Provider, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createDiscoveryProvider } from "../src/discovery/provider.ts";
import { createSnapshotRepository } from "../src/discovery/snapshot.ts";
import type { DiscoveryAccess, DiscoveryClock, RelayFamily, SnapshotRepository, ChameleonProviderId } from "../src/discovery/types.ts";

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
function nativeContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
	return {
		allowNetwork: false, signal: new AbortController().signal,
		publish: async ({ update }) => { update?.(); return true; },
		...overrides,
	};
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
		credentials: InMemoryCredentialStore; bind(): void; states: string[]; provider: Provider; dispose(): void;
	}) => Promise<void>,
	options: { family?: RelayFamily; providerConfig?: unknown; repository?: SnapshotRepository; clock?: DiscoveryClock;
		resolveAccess?: () => Promise<DiscoveryAccess | undefined> } = {},
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
		await run({ runtime, registry, path, repository, credentials, states, ...discovery, bind() {
			resolveAccess = options.resolveAccess ?? (async () => {
				const resolved = await registry.getProviderAuth(id);
				return resolved ? {
					baseUrl: resolved.auth.baseUrl ?? registry.getProvider(id)?.baseUrl ?? "",
					apiKey: resolved.auth.apiKey, headers: resolved.auth.headers,
				} : undefined;
			});
		} });
	} finally {
		discovery.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

for (const family of ["claude", "codex"] as const) {
	test(`${family}: rejected identity publication retains the old catalog until a permitted restore`, async () => {
		const id: ChameleonProviderId = `chameleon-${family}`;
		const prefix = family === "claude" ? "claude" : "gpt";
		let access: DiscoveryAccess = { baseUrl: config.baseUrl, apiKey: config.apiKey };
		const net = network({ data: [{ id: `${prefix}-previous` }], has_more: false });
		await withRuntime(net.fetch, async ({ bind, registry, provider, repository, states }) => {
			bind();
			await registry.refresh({ providers: [id], allowNetwork: true, force: true });
			access = { ...access, headers: { "X-Access": "synthetic-new-scope" } };
			const identity = await repository.identity({ ...access, headers: { "x-access": "synthetic-new-scope" } });
			await repository.saveSuccess(id, identity, { checkedAt: 7, records: [{ id: `${prefix}-restored` }] });
			const before = [...states];
			await provider.refreshModels!(nativeContext({ publish: async () => false }));
			assert.deepEqual(provider.getModels().map((model) => model.id), [`${prefix}-previous`]);
			assert.deepEqual(states, before, "a rejected identity update reports no committed target state");
			await registry.refresh({ providers: [id], allowNetwork: false });
			assert.deepEqual(provider.getAllModels!().map((model) => model.id), [`${prefix}-restored`]);
			assert.equal(states.at(-1), "cache");
			assert.equal(net.requests.length, 1);
		}, { family, resolveAccess: async () => access });
	});
	test(`${family}: an aborted waiter leaves a completed shared job for the newest cache-only waiter still resolving access`, async () => {
		const id: ChameleonProviderId = `chameleon-${family}`;
		const modelId = family === "claude" ? "claude-takeover" : "gpt-takeover";
		const started = deferred<void>();
		const response = deferred<Response>();
		const resolving = deferred<void>();
		const accessReady = deferred<void>();
		let delayAccess = false;
		let requests = 0;
		let signal: AbortSignal | undefined;
		await withRuntime(async (_url, init) => {
			requests++; signal = init?.signal ?? undefined; started.resolve(); return response.promise;
		}, async ({ bind, registry, provider, repository }) => {
			bind();
			await registry.refresh({ providers: [id], allowNetwork: false });
			const old = new AbortController();
			const first = provider.refreshModels!(nativeContext({ allowNetwork: true, signal: old.signal }));
			await started.promise;
			delayAccess = true;
			const second = provider.refreshModels!(nativeContext());
			await resolving.promise;
			old.abort();
			response.resolve(Response.json({ data: [{ id: modelId }], has_more: false }));
			await first;
			assert.equal(signal?.aborted, false, "cancelled native waiters do not own transport cancellation");
			accessReady.resolve();
			await second;
			assert.equal(requests, 1);
			assert.deepEqual(provider.getModels().map((model) => model.id), [modelId]);
			const identity = await repository.identity({ baseUrl: config.baseUrl, apiKey: config.apiKey });
			assert.deepEqual((await repository.read(id, identity)).snapshot?.records, [{ id: modelId }]);
		}, { family, resolveAccess: async () => {
			if (delayAccess) { resolving.resolve(); await accessReady.promise; }
			return { baseUrl: config.baseUrl, apiKey: config.apiKey };
		} });
	});
	test(`${family}: failed suspension persistence keeps candidates disabled through ordinary failure and restart`, async () => {
		const id: ChameleonProviderId = `chameleon-${family}`;
		const modelId = family === "claude" ? "claude-permitted" : "gpt-permitted";
		const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-suspension-unsaved-"));
		const access = { baseUrl: config.baseUrl, apiKey: config.apiKey };
		const repository = createSnapshotRepository({ directory, io: { async rename(from, to) {
			const staged = JSON.parse(await readFile(from, "utf8"));
			if (staged.pending === false && staged.suspended) throw new Error("SYNTHETIC_SUSPENSION_WRITE_FAILURE");
			await rename(from, to);
		} } });
		const net = network(
			{ data: [{ id: modelId }], has_more: false },
			new Response("synthetic permission failure", { status: family === "claude" ? 401 : 403 }),
			new Error("synthetic ordinary failure"),
		);
		try {
			await withRuntime(net.fetch, async ({ bind, registry, runtime, states }) => {
				bind();
				const refresh = () => registry.refresh({ providers: [id], allowNetwork: true, force: true });
				await refresh();
				await refresh();
				assert.equal(states.at(-1), "suspension-unsaved");
				assert.deepEqual(runtime.getModels(id), []);
				await refresh();
				assert.equal(states.at(-1), "failed");
				assert.deepEqual(runtime.getModels(id), []);
			}, { family, repository, resolveAccess: async () => access });
			const restarted = createSnapshotRepository({ directory });
			const identity = await restarted.identity(access);
			const durable = await restarted.read(id, identity);
			assert.equal(durable.suspended, true);
			assert.deepEqual(durable.snapshot?.records, [{ id: modelId }]);
			await withRuntime(network().fetch, async ({ bind, registry, runtime }) => {
				bind();
				await registry.refresh({ providers: [id], allowNetwork: false });
				assert.deepEqual(runtime.getModels(id), []);
			}, { family, repository: restarted, resolveAccess: async () => access });
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
	test(`${family}: a late save cannot overwrite a forced replacement or its persisted snapshot`, async () => {
		const id: ChameleonProviderId = `chameleon-${family}`;
		const prefix = family === "claude" ? "claude" : "gpt";
		const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-late-provider-save-"));
		const staged = deferred<void>();
		const release = deferred<void>();
		const access = { baseUrl: config.baseUrl, apiKey: config.apiKey };
		const repository = createSnapshotRepository({ directory, io: { async writeFile(path, bytes, options) {
			await writeFile(path, bytes, options);
			if (typeof bytes === "string") {
				const value = JSON.parse(bytes);
				if (value.pending === false && value.snapshot?.records[0]?.id === `${prefix}-old-save`) {
					staged.resolve();
					await release.promise;
				}
			}
		} } });
		const net = network(
			{ data: [{ id: `${prefix}-old-save` }], has_more: false },
			{ data: [{ id: `${prefix}-replacement` }], has_more: false },
		);
		try {
			await withRuntime(net.fetch, async ({ bind, registry, provider, states }) => {
				bind();
				await registry.refresh({ providers: [id], allowNetwork: false });
				const old = provider.refreshModels!(nativeContext({ allowNetwork: true, force: true }));
				await staged.promise;
				assert.deepEqual(provider.getModels().map((model) => model.id), [`${prefix}-old-save`]);
				await provider.refreshModels!(nativeContext({ allowNetwork: true, force: true }));
				const before = [...states];
				release.resolve();
				await old;
				assert.deepEqual(states, before, "a late save cannot report completion for a retired waiter");
				assert.equal(states.at(-1), "success");
				assert.deepEqual(provider.getModels().map((model) => model.id), [`${prefix}-replacement`]);
				const identity = await repository.identity(access);
				assert.deepEqual((await repository.read(id, identity)).snapshot?.records, [{ id: `${prefix}-replacement` }]);
			}, { family, repository, resolveAccess: async () => access });
		} finally { release.resolve(); await rm(directory, { recursive: true, force: true }); }
	});
	for (const pending of [false, true]) {
		test(`${family}: dispose clears memory without changing the ${pending ? "pending verification" : "successful snapshot"} on disk`, async () => {
			const id: ChameleonProviderId = `chameleon-${family}`;
			const modelId = family === "claude" ? "claude-before-dispose" : "gpt-before-dispose";
			const access = { baseUrl: config.baseUrl, apiKey: config.apiKey };
			const started = deferred<void>();
			const response = deferred<Response>();
			let requests = 0;
			let signal: AbortSignal | undefined;
			await withRuntime(async (_url, init) => {
				requests++;
				if (requests === 1) return Response.json({ data: [{ id: modelId }], has_more: false });
				signal = init?.signal ?? undefined; started.resolve(); return response.promise;
			}, async ({ bind, registry, provider, dispose, repository, states }) => {
				bind();
				await registry.refresh({ providers: [id], allowNetwork: true, force: true });
				let refreshing: Promise<void> | undefined;
				if (pending) {
					refreshing = provider.refreshModels!(nativeContext({ allowNetwork: true, force: true }));
					await started.promise;
				}
				const identity = await repository.identity(access);
				const durable = await repository.read(id, identity);
				const before = [...states];
				dispose();
				dispose();
				assert.deepEqual(provider.getModels(), []);
				assert.deepEqual(provider.getAllModels!(), []);
				if (pending) assert.equal(signal?.aborted, true);
				await provider.refreshModels!(nativeContext({ allowNetwork: true, force: true }));
				response.resolve(Response.json({ data: [{ id: `${modelId}-late` }], has_more: false }));
				await refreshing;
				assert.deepEqual(provider.getModels(), []);
				assert.deepEqual(states, before);
				assert.equal(requests, pending ? 2 : 1);
				assert.deepEqual(await repository.read(id, identity), durable);
				await withRuntime(network().fetch, async ({ bind, registry, runtime }) => {
					bind();
					await registry.refresh({ providers: [id], allowNetwork: false });
					assert.deepEqual(runtime.getModels(id).map((model) => model.id), pending ? [] : [modelId]);
				}, { family, repository, resolveAccess: async () => access });
			}, { family, resolveAccess: async () => access });
		});
	}
	test(`${family}: an empty offline variable suppresses even forced network refresh`, async () => {
		const id: ChameleonProviderId = `chameleon-${family}`;
		const net = network();
		const previous = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "";
		try {
			await withRuntime(net.fetch, async ({ bind, registry, runtime }) => {
				bind();
				await registry.refresh({ providers: [id], allowNetwork: true, force: true });
				assert.deepEqual(runtime.getModels(id), []);
				assert.equal(net.requests.length, 0);
			}, { family });
		} finally {
			if (previous === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previous;
		}
	});
	for (const publication of ["rejected", "invalidated-after-update"] as const) {
		test(`${family}: ${publication} success publication does not save or announce a completed verification`, async () => {
			const id: ChameleonProviderId = `chameleon-${family}`;
			const prefix = family === "claude" ? "claude" : "gpt";
			const net = network(
				{ data: [{ id: `${prefix}-previous` }], has_more: false },
				{ data: [{ id: `${prefix}-target` }], has_more: false },
			);
			const access = { baseUrl: config.baseUrl, apiKey: config.apiKey };
			await withRuntime(net.fetch, async ({ bind, registry, provider, repository, states }) => {
				bind();
				await registry.refresh({ providers: [id], allowNetwork: true, force: true });
				const controller = new AbortController();
				await provider.refreshModels!(nativeContext({
					allowNetwork: true, force: true, signal: controller.signal,
					publish: async ({ update }) => {
						if (publication === "rejected") return false;
						update?.();
						controller.abort();
						return true;
					},
				}));
				assert.deepEqual(provider.getModels().map((model) => model.id),
					[`${prefix}-${publication === "rejected" ? "previous" : "target"}`]);
				assert.equal(states.at(-1), "loading", "neither denied nor invalidated publication completes verification");
				const identity = await repository.identity(access);
				const durable = await repository.read(id, identity);
				assert.deepEqual(durable.snapshot?.records, [{ id: `${prefix}-previous` }]);
				assert.equal(durable.suspended, true, "the unsaved verification retains its pending barrier");
				await withRuntime(network().fetch, async ({ bind, registry, runtime }) => {
					bind();
					await registry.refresh({ providers: [id], allowNetwork: false });
					assert.deepEqual(runtime.getModels(id), [], "restart cannot recover the intact previous disk snapshot");
				}, { family, repository, resolveAccess: async () => access });
			}, { family, resolveAccess: async () => access });
		});
	}
}

test("native network verification durably claims before GET without hiding this process's successful catalog", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-begin-before-get-"));
	const repository = createSnapshotRepository({ directory });
	const identity = await repository.identity({ baseUrl: config.baseUrl, apiKey: config.apiKey, headers: { authorization: "Bearer synthetic-list-key" } });
	const previous = { checkedAt: 1, records: [{ id: "gpt-prior" }] };
	await repository.saveSuccess(codexId, identity, previous);
	let observed: Awaited<ReturnType<SnapshotRepository["read"]>> | undefined;
	try {
		await withRuntime(async () => {
			observed = await createSnapshotRepository({ directory }).read(codexId, identity);
			return Response.json({ data: [{ id: "gpt-verified" }] });
		}, async ({ bind, registry, runtime }) => {
			bind();
			await registry.refresh({ providers: [codexId], allowNetwork: false });
			assert.deepEqual(runtime.getModels(codexId).map((model) => model.id), ["gpt-prior"]);
			await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
			assert.deepEqual(observed, { snapshot: previous, suspended: true }, "GET must start only after a durable pending claim");
			assert.deepEqual(runtime.getModels(codexId).map((model) => model.id), ["gpt-verified"]);
			assert.equal((await repository.read(codexId, identity)).suspended, false);
		}, { repository });
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("an ordinary list failure releases its own pending claim and preserves restart cache", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-release-failure-"));
	const repository = createSnapshotRepository({ directory });
	const identity = await repository.identity({ baseUrl: config.baseUrl, apiKey: config.apiKey, headers: { authorization: "Bearer synthetic-list-key" } });
	const previous = { checkedAt: 1, records: [{ id: "gpt-prior" }] };
	await repository.saveSuccess(codexId, identity, previous);
	try {
		await withRuntime(network(new Error("SYNTHETIC_ORDINARY_FAILURE")).fetch, async ({ bind, registry, runtime, states }) => {
			bind();
			await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
			assert.equal(states.at(-1), "failed");
			assert.deepEqual(runtime.getModels(codexId).map((model) => model.id), ["gpt-prior"]);
			assert.deepEqual(await createSnapshotRepository({ directory }).read(codexId, identity), { snapshot: previous, suspended: false });
		}, { repository });
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed durable job admission sends no GET and never clears an existing successful catalog", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-begin-failure-"));
	const repository = createSnapshotRepository({ directory });
	const identity = await repository.identity({ baseUrl: config.baseUrl, apiKey: config.apiKey, headers: { authorization: "Bearer synthetic-list-key" } });
	const previous = { checkedAt: 1, records: [{ id: "gpt-prior" }] };
	await repository.saveSuccess(codexId, identity, previous);
	const faulty = createSnapshotRepository({ directory, io: { rename: async () => { throw new Error("SYNTHETIC_BEGIN_SECRET"); } } });
	const net = network({ data: [{ id: "gpt-must-not-fetch" }] });
	try {
		await withRuntime(net.fetch, async ({ bind, registry, runtime, states }) => {
			bind();
			await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
			assert.equal(net.requests.length, 0);
			assert.equal(states.at(-1), "failed");
			assert.deepEqual(runtime.getModels(codexId).map((model) => model.id), ["gpt-prior"]);
			assert.deepEqual(await repository.read(codexId, identity), { snapshot: previous, suspended: false });
		}, { repository: faulty });
	} finally { await rm(directory, { recursive: true, force: true }); }
});

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

test("a failed snapshot commit keeps the latest memory catalog and blocks restart reuse of intact old data", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-failed-save-"));
	let failWrites = false;
	const repository = createSnapshotRepository({ directory, io: { async rename(from, to) {
		const staged = JSON.parse(await readFile(from, "utf8"));
		if (failWrites && staged.pending === false) throw new Error("storage synthetic-list-key");
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
			}, { repository, clock: clock().value });
		await withRuntime(network().fetch, async ({ bind, registry, runtime, repository: restarted }) => {
			bind();
			await registry.refresh({ providers: [codexId], allowNetwork: false });
			assert.deepEqual(runtime.getModels(codexId), [], "pending verification blocks restart publication, not this process's latest memory");
			const identity = await restarted.identity({ baseUrl: config.baseUrl, apiKey: config.apiKey, headers: { authorization: "Bearer synthetic-list-key" } });
			assert.deepEqual(await restarted.read(codexId, identity), {
				snapshot: { checkedAt: 1_000, records: [{ id: "gpt-old" }] }, suspended: true,
			});
		}, { repository: createSnapshotRepository({ directory }) });
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("a failed raw access resolver clears the previous automatic identity without touching explicit models", async () => {
	let failAccess = false;
	const net = network({ data: [{ id: "gpt-old-access" }] });
	await withRuntime(net.fetch, async ({ bind, registry, runtime, states }) => {
		bind();
		await registry.refresh({ providers: [codexId], allowNetwork: true, force: true });
		assert.deepEqual(runtime.getModels(codexId).map((model) => model.id), ["gpt-old-access", "explicit-only"]);
		failAccess = true;
		await registry.refresh({ providers: [codexId], allowNetwork: false });
		assert.deepEqual(runtime.getModels(codexId).map((model) => model.id), ["explicit-only"]);
		assert.equal(states.at(-1), "unconfigured");
		assert.equal(net.requests.length, 1);
	}, {
		providerConfig: { ...config, models: [{ id: "explicit-only", api: "openai-responses", name: "User choice", reasoning: false }] },
		resolveAccess: async () => {
			if (failAccess) throw new Error("SYNTHETIC_RESOLVER_SECRET");
			return { baseUrl: config.baseUrl, apiKey: config.apiKey };
		},
	});
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

test("a cache-only refresh adopts the existing shared request after Pi supersedes and aborts the old network waiter", async () => {
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
		// An already-started network job may be joined by a later cache-only phase; it must not start another GET.
		const second = registry.refresh({ providers: [codexId], allowNetwork: false });
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

test("two providers keep independent 15-second budgets: a slow one cannot drag or cover the fast one", async () => {
	const time = clock();
	const slowStarted = deferred<void>();
	const fastStarted = deferred<void>();
	const fastPublished = deferred<void>();
	const slowRelease = deferred<Response>();
	let slowSignal: AbortSignal | undefined;
	const fetch: FetchFunction = async (_input, init = {}) => {
		if (new Headers(init.headers).has("authorization")) {
			slowSignal = init.signal ?? undefined;
			slowStarted.resolve();
			return slowRelease.promise; // Deliberately ignores cancellation.
		}
		fastStarted.resolve();
		return Response.json({ data: [{ id: "claude-fast-dual" }], has_more: false });
	};
	const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-discovery-dual-"));
	const states: Record<RelayFamily, string[]> = { claude: [], codex: [] };
	const providers = (["claude", "codex"] as RelayFamily[]).map((family) => createDiscoveryProvider(family, {
		fetch, clock: time.value,
		repository: createSnapshotRepository({ directory: join(directory, `cache-${family}`) }),
		resolveAccess: async () => ({
			baseUrl: family === "codex" ? "https://relay.example.test/v1" : "https://relay.example.test",
			apiKey: `synthetic-${family}-key`, headers: {},
		}),
		onChange: (state) => {
			states[state.provider === codexId ? "codex" : "claude"].push(state.status);
			if (state.provider === "chameleon-claude" && state.status === "success") fastPublished.resolve();
		},
	}));
	try {
		const path = join(directory, "models.json");
		await writeFile(path, JSON.stringify({ providers: {
			[codexId]: config,
			"chameleon-claude": { baseUrl: "https://relay.example.test", apiKey: "synthetic-claude-key" },
		} }));
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(), modelsPath: path, modelsStore: new InMemoryModelsStore(),
			refreshOnCreate: false, allowModelNetwork: false,
		});
		for (const { provider } of providers) runtime.registerNativeProvider(provider);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const registry = new ModelRegistry(runtime);
		const refreshing = registry.refresh({ providers: [codexId, "chameleon-claude"], allowNetwork: true });
		await Promise.all([slowStarted.promise, fastStarted.promise, fastPublished.promise]);
		time.advance(15_000);
		await refreshing;
		assert.equal(slowSignal?.aborted, true, "the slow provider's own budget must abort its GET");
		assert.equal(states.codex.at(-1), "failed");
		assert.deepEqual(runtime.getModels(codexId), [], "the slow provider publishes nothing");
		assert.ok(states.claude.includes("success"), "the fast provider completes within the same shared clock");
		assert.deepEqual(runtime.getModels("chameleon-claude").map((model) => model.id), ["claude-fast-dual"]);
		slowRelease.resolve(Response.json({ data: [{ id: "gpt-late-dual" }] }));
		await registry.refresh({ providers: [codexId], allowNetwork: false });
		assert.deepEqual(runtime.getModels(codexId), [], "a late body is never published after the budget");
	} finally {
		for (const { dispose } of providers) dispose();
		await rm(directory, { recursive: true, force: true });
	}
});
