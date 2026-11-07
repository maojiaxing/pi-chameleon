import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
	const states: string[] = [];
	let resolveAccess: (() => Promise<DiscoveryAccess | undefined>) | undefined;
	const discovery = createDiscoveryProvider(family, {
		fetch, repository, clock: options.clock,
		resolveAccess: () => resolveAccess?.() ?? Promise.resolve(undefined),
		onChange: (state) => { states.push(state.status); },
	});
	try {
		const path = join(directory, "models.json");
		await writeFile(path, JSON.stringify({ providers: { [id]: options.providerConfig ?? config } }));
		const runtime = await ModelRuntime.create({
			credentials, modelsPath: path, modelsStore: new InMemoryModelsStore(),
			refreshOnCreate: false, allowModelNetwork: false,
		});
		runtime.registerNativeProvider(discovery.provider);
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
