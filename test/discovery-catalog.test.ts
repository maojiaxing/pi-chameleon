import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createProvider, envApiKeyAuth, InMemoryCredentialStore, InMemoryModelsStore,
	type Api, type FetchFunction, type Model,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { claudeCodeStream, claudeCodeStreamSimple } from "../src/claude/stream.ts";
import { codexStream, codexStreamSimple } from "../src/codex/stream.ts";
import { buildModels, CatalogFetchError, fetchCatalog } from "../src/discovery/catalog.ts";
import type { CatalogRecord, DiscoveryClock, RelayFamily } from "../src/discovery/types.ts";

interface CapturedRequest { url: string; init: RequestInit; headers: Headers }
function network(...responses: unknown[]) {
	const requests: CapturedRequest[] = [];
	const fetch: FetchFunction = async (input, init = {}) => {
		requests.push({ url: String(input), init, headers: new Headers(init.headers) });
		assert.ok(responses.length, "unexpected network request");
		return Response.json(responses.shift());
	};
	return { fetch, requests };
}

async function withDiscovery(
	family: RelayFamily, config: Record<string, unknown>, fetch: FetchFunction,
	run: (runtime: ModelRuntime, registry: ModelRegistry) => Promise<void>,
	options: { clock?: DiscoveryClock; budgetMs?: number; records?: readonly CatalogRecord[] } = {},
) {
	const dir = await mkdtemp(join(tmpdir(), "pi-chameleon-catalog-"));
	const id = `chameleon-${family}`;
	try {
		const path = join(dir, "models.json");
		await writeFile(path, JSON.stringify({ providers: { [id]: config } }));
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(), modelsPath: path,
			modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false,
		});
		const registry = new ModelRegistry(runtime);
		let models: readonly Model<Api>[] = [];
		const provider = createProvider({
			id, auth: { apiKey: envApiKeyAuth("Relay API key", []) }, models: [],
			api: family === "claude"
				? { stream: claudeCodeStream, streamSimple: claudeCodeStreamSimple }
				: { stream: codexStream, streamSimple: codexStreamSimple },
		});
		runtime.registerNativeProvider({
			...provider,
			getModels: () => models,
			getAllModels: () => models,
			async refreshModels(context) {
				if (!context.allowNetwork) return;
				const resolved = await registry.getProviderAuth(id);
				const access = {
					baseUrl: resolved?.auth.baseUrl ?? registry.getProvider(id)?.baseUrl ?? "",
					apiKey: resolved?.auth.apiKey,
					headers: resolved?.auth.headers,
				};
				const records = options.records ?? await fetchCatalog(family, access, { fetch, signal: context.signal, ...options });
				const next = buildModels(family, access.baseUrl, records);
				await context.publish({ update: () => { models = next; } });
			},
		});
		await run(runtime, registry);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("runtime rejects namespaced automatic candidates but preserves raw IDs and explicit models", async () => {
	for (const family of ["claude", "codex"] as const) {
		const raw = family === "claude" ? ["claude-future"] : ["gpt-future", "chatgpt-future", "codex-future", "o9-future"];
		const namespaced = raw.map((id) => `${id}/unknown-alias`);
		const explicit = namespaced[0];
		const net = network({ data: [...raw, ...namespaced].map((id) => ({ id })), has_more: false });
		await withDiscovery(family, { api: family === "claude" ? "anthropic-messages" : "openai-responses", baseUrl: "https://relay.example.test/v1", apiKey: "synthetic", models: [{ id: explicit, name: "Explicit namespace", contextWindow: 8192, maxTokens: 1024, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] }, net.fetch, async (runtime) => {
			await refresh(runtime, family);
			assert.deepEqual(runtime.getModels(`chameleon-${family}`).map((model) => model.id).sort(), [...raw, explicit].sort());
		});
	}
});

const codexConfig = { baseUrl: "https://relay.example.test/gateway/v1", apiKey: "synthetic-effective-key" };

async function refresh(runtime: ModelRuntime, family: RelayFamily, signal?: AbortSignal) {
	return runtime.refresh({ providers: [`chameleon-${family}`], allowNetwork: true, force: true, signal });
}
test("a new Codex candidate is published through the native runtime without a member whitelist", async () => {
	const net = network({ object: "list", data: [{ id: "GPT-future" }] });
	await withDiscovery("codex", codexConfig, net.fetch, async (runtime) => {
		assert.equal(runtime.getModels("chameleon-codex").length, 0);
		const result = await refresh(runtime, "codex");
		assert.equal(result.errors.size, 0);
		const [model] = runtime.getModels("chameleon-codex");
		assert.equal(model.id, "GPT-future");
		assert.equal(model.api, "openai-responses");
		assert.equal(model.provider, "chameleon-codex");
		assert.equal(model.baseUrl, "https://relay.example.test/gateway/v1");
		assert.equal(model.contextWindow, 32_768);
		assert.equal(model.maxTokens, 4_096);
		assert.deepEqual(model.input, ["text"]);
		assert.equal(model.reasoning, false);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.match(model.name, /能力未确认/);
		assert.match(model.name, /费用未知.*不代表免费/);
		assert.equal(model.thinkingLevelMap, undefined);
		assert.equal(model.compat, undefined);
		assert.equal(net.requests[0].url, "https://relay.example.test/gateway/v1/models");
		assert.equal(net.requests[0].init.method, "GET");
		assert.equal(net.requests[0].init.body, undefined);
		assert.equal(net.requests[0].headers.get("authorization"), "Bearer synthetic-effective-key");
	});
});

test("standard Anthropic metadata wins per field while null gaps use exact references or conservative budgets", async () => {
	const net = network({ data: [
		{
			id: "claude-sonnet-4-6", display_name: "Relay Sonnet", max_input_tokens: 8_192, max_tokens: 1_024,
			capabilities: { image_input: { supported: false }, thinking: { supported: false } },
			cost: { input: 99 }, api: "private-api", provider: "upstream-identity", baseUrl: "https://upstream.example.test",
		},
		{
			id: "claude-future", display_name: "Future relay", max_input_tokens: 2_048, max_tokens: null,
			capabilities: { image_input: { supported: true }, thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } } },
		},
		{ id: "claude-sonnet-4-5", display_name: null, max_input_tokens: null, max_tokens: null, capabilities: null },
		{ id: "claude-incomplete", max_input_tokens: 512, capabilities: { image_input: { supported: false }, thinking: { supported: false } } },
	], has_more: false });
	await withDiscovery("claude", codexConfig, net.fetch, async (runtime) => {
		assert.equal((await refresh(runtime, "claude")).errors.size, 0);
		const known = runtime.getModel("chameleon-claude", "claude-sonnet-4-6")!;
		assert.match(known.name, /^Relay Sonnet/);
		assert.equal(known.id, "claude-sonnet-4-6");
		assert.equal(known.contextWindow, 8_192);
		assert.equal(known.maxTokens, 1_024);
		assert.deepEqual(known.input, ["text"]);
		assert.equal(known.reasoning, false);
		assert.ok(known.compat && "forceAdaptiveThinking" in known.compat);
		assert.equal(known.compat.forceAdaptiveThinking, false);
		assert.deepEqual(known.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		assert.match(known.name, /参考费用/);
		assert.doesNotMatch(known.name, /能力未确认/);
		const future = runtime.getModel("chameleon-claude", "claude-future")!;
		assert.equal(future.contextWindow, 2_048);
		assert.equal(future.maxTokens, 2_048);
		assert.deepEqual(future.input, ["text", "image"]);
		assert.equal(future.reasoning, true);
		assert.ok(future.compat && "forceAdaptiveThinking" in future.compat);
		assert.equal(future.compat.forceAdaptiveThinking, true);
		assert.match(future.name, /能力未确认.*费用未知.*不代表免费/);
		const fallback = runtime.getModel("chameleon-claude", "claude-sonnet-4-5")!;
		assert.equal(fallback.contextWindow, 200_000);
		assert.equal(fallback.maxTokens, 64_000);
		const incomplete = runtime.getModel("chameleon-claude", "claude-incomplete")!;
		assert.equal(incomplete.contextWindow, 512);
		assert.equal(incomplete.maxTokens, 512);
		assert.equal(incomplete.reasoning, false);
		assert.match(incomplete.name, /能力未确认/);
		for (const model of runtime.getModels("chameleon-claude")) {
			assert.equal(model.provider, "chameleon-claude");
			assert.equal(model.api, "anthropic-messages");
			assert.equal(model.baseUrl, codexConfig.baseUrl);
			assert.equal(model.headers, undefined);
		}
	});
});

test("Claude discovery uses only provider-level auth and headers, including Pi's uppercase Authorization", async () => {
	for (const authHeader of [false, true]) {
		const net = network({ data: [{ id: "claude-future" }], has_more: false, first_id: "claude-future", last_id: "claude-future" });
		await withDiscovery("claude", {
			baseUrl: "https://relay.example.test/gateway/", apiKey: "synthetic-effective-key", authHeader,
			headers: {
				"X-Tenant": "synthetic-workspace", "Authorization": "Bearer stale-key",
				"X-Api-Key": "alternate-key", "Cookie": "secret-cookie", "Proxy-Authorization": "proxy-secret",
				"CF-AIG-Authorization": "gateway-secret", "ChatGPT-Account-ID": "account-secret",
				"User-Agent": "codex_cli_rs", "session_id": "chat-session", "originator": "codex_cli_rs",
				"anthropic-beta": "cli-disguise", "x-stainless-lang": "js",
			},
		}, net.fetch, async (runtime, registry) => {
			const auth = await registry.getProviderAuth("chameleon-claude");
			if (authHeader) assert.equal(auth?.auth.headers?.Authorization, "Bearer synthetic-effective-key");
			const result = await refresh(runtime, "claude");
			assert.equal(result.errors.size, 0);
			assert.deepEqual(runtime.getModels("chameleon-claude").map((model) => model.id), ["claude-future"]);
			const request = net.requests[0];
			assert.equal(request.url, "https://relay.example.test/gateway/v1/models");
			assert.equal(request.init.redirect, "error");
			assert.equal(request.init.credentials, "omit");
			assert.equal(request.headers.get("authorization"), authHeader ? "Bearer synthetic-effective-key" : null);
			assert.equal(request.headers.get("x-api-key"), authHeader ? null : "synthetic-effective-key");
			assert.equal(request.headers.get("anthropic-version"), "2026-10-21");
			assert.equal(request.headers.get("x-tenant"), "synthetic-workspace");
			for (const name of ["cookie", "proxy-authorization", "cf-aig-authorization", "chatgpt-account-id", "user-agent", "session_id", "originator", "anthropic-beta", "x-stainless-lang"]) {
				assert.equal(request.headers.get(name), null, `${name} must not accompany discovery`);
			}
		});
	}
});

test("family rules preserve raw IDs, exclude non-chat uses and namespaces, and publish a legitimate empty result", async () => {
	const data = [
		{ id: "CLAUDE-next" }, { id: "GPT-next" }, { id: "chatgpt-next" }, { id: "codex-next" },
		{ id: "O42-mini" }, { id: "gpt-vision-chat" }, { id: "gpt-image-1" }, { id: "gpt-4o-audio-preview" },
		{ id: "gpt-4o-realtime-preview" }, { id: "gpt-embedding-new" }, { id: "gpt-4o-mini-tts" },
		{ id: "gpt-4o-transcribe" }, { id: "claude-audio-new" }, { id: "relay/gpt-next" },
		{ id: "org/claude-next" }, { id: "private-alias", api: "openai-responses", type: "chat" },
		{ id: "ocean-chat" }, { id: "o7private" },
	];
	for (const family of ["claude", "codex"] as const) {
		const net = network({ data, has_more: false }, { data: [], has_more: false }, { data: [{ id: "private-alias" }], has_more: false });
		await withDiscovery(family, codexConfig, net.fetch, async (runtime) => {
			assert.equal((await refresh(runtime, family)).errors.size, 0);
			assert.deepEqual(runtime.getModels(`chameleon-${family}`).map((model) => model.id), family === "claude"
				? ["CLAUDE-next"] : ["GPT-next", "chatgpt-next", "codex-next", "O42-mini", "gpt-vision-chat"]);
			assert.equal((await refresh(runtime, family)).errors.size, 0);
			assert.deepEqual(runtime.getModels(`chameleon-${family}`), []);
			assert.equal((await refresh(runtime, family)).errors.size, 0);
			assert.deepEqual(runtime.getModels(`chameleon-${family}`), []);
		});
	}
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}

test("Claude publishes only the full cursor sequence and removes identical duplicates", async () => {
	const pageRequested = deferred<void>();
	const lastPage = deferred<Response>();
	const requests: CapturedRequest[] = [];
	const responses = [
		{ data: [{ id: "claude-old" }], has_more: false },
		{ data: [{ id: "Claude-New" }, { id: "private+cursor" }], has_more: true, first_id: "Claude-New", last_id: "private+cursor" },
	];
	const fetch: FetchFunction = async (input, init = {}) => {
		requests.push({ url: String(input), init, headers: new Headers(init.headers) });
		if (responses.length) return Response.json(responses.shift());
		pageRequested.resolve();
		return lastPage.promise;
	};
	await withDiscovery("claude", codexConfig, fetch, async (runtime) => {
		assert.equal((await refresh(runtime, "claude")).errors.size, 0);
		const pending = refresh(runtime, "claude");
		await Promise.race([pageRequested.promise, pending.then(() => { throw new Error("refresh must await all cursor pages"); })]);
		assert.deepEqual(runtime.getModels("chameleon-claude").map((model) => model.id), ["claude-old"]);
		assert.equal(requests[2].url, "https://relay.example.test/gateway/v1/v1/models?after_id=private%2Bcursor");
		lastPage.resolve(Response.json({ data: [{ id: "Claude-New" }, { id: "claude-final" }], has_more: false }));
		assert.equal((await pending).errors.size, 0);
		assert.deepEqual(runtime.getModels("chameleon-claude").map((model) => model.id), ["Claude-New", "claude-final"]);
	});
});

test("invalid responses and conflicting IDs fail atomically without publishing partial candidates", async () => {
	const scenarios: { body: unknown; code: string }[] = [
		{ body: null, code: "invalid-response" }, { body: { models: [{ id: "gpt-new" }] }, code: "invalid-response" },
		{ body: { data: {} }, code: "invalid-response" },
		{ body: { data: [{ id: "gpt-new" }, {}] }, code: "invalid-response" },
		{ body: { data: [{ id: "   " }] }, code: "invalid-response" },
		{ body: { data: [{ id: 123 }] }, code: "invalid-response" },
		{ body: { data: [{ id: "gpt-new", owned_by: "one" }, { id: "gpt-new", owned_by: "two" }] }, code: "conflicting-model" },
		{ body: { data: [{ id: "private-alias", created: 1 }, { id: "private-alias", created: 2 }] }, code: "conflicting-model" },
	];
	for (const scenario of scenarios) {
		const net = network({ data: [{ id: "gpt-old" }] }, scenario.body);
		await withDiscovery("codex", codexConfig, net.fetch, async (runtime) => {
			assert.equal((await refresh(runtime, "codex")).errors.size, 0);
			const result = await refresh(runtime, "codex");
			const error = result.errors.get("chameleon-codex");
			assert.ok(error instanceof CatalogFetchError);
			assert.equal(error.code, scenario.code);
			assert.deepEqual(runtime.getModels("chameleon-codex").map((model) => model.id), ["gpt-old"]);
		});
	}
});

test("malformed or looping Claude pagination fails as a whole and retains the preceding directory", async () => {
	const sequences: unknown[][] = [
		[{ data: [{ id: "claude-new" }] }],
		[{ data: [{ id: "claude-new" }], has_more: "true" }],
		[{ data: [], has_more: true, last_id: "missing" }],
		[{ data: [{ id: "claude-new" }], has_more: true }],
		[{ data: [{ id: "claude-new" }], has_more: true, last_id: "another-id" }],
		[{ data: [{ id: "claude-new" }], has_more: false, first_id: "another-id" }],
		[{ data: [{ id: "claude-new" }], has_more: true, last_id: "claude-new" }, { data: [{ id: "claude-new" }], has_more: true, last_id: "claude-new" }],
	];
	for (const pages of sequences) {
		const net = network({ data: [{ id: "claude-old" }], has_more: false }, ...pages);
		await withDiscovery("claude", codexConfig, net.fetch, async (runtime) => {
			assert.equal((await refresh(runtime, "claude")).errors.size, 0);
			const error = (await refresh(runtime, "claude")).errors.get("chameleon-claude");
			assert.ok(error instanceof CatalogFetchError);
			assert.equal(error.code, "invalid-pagination");
			assert.deepEqual(runtime.getModels("chameleon-claude").map((model) => model.id), ["claude-old"]);
		});
	}
	const net = network(
		{ data: [{ id: "claude-old" }], has_more: false },
		{ data: [{ id: "claude-new" }], has_more: true, last_id: "claude-new" },
		{ data: [{ id: "claude-new", display_name: "changed" }], has_more: false },
	);
	await withDiscovery("claude", codexConfig, net.fetch, async (runtime) => {
		await refresh(runtime, "claude");
		const error = (await refresh(runtime, "claude")).errors.get("chameleon-claude");
		assert.ok(error instanceof CatalogFetchError);
		assert.equal(error.code, "conflicting-model");
		assert.deepEqual(runtime.getModels("chameleon-claude").map((model) => model.id), ["claude-old"]);
	});
});

test("OpenAI does not invent pagination and exact JSON duplicates are deduplicated independent of key order", async () => {
	const net = network({
		data: [{ id: "gpt-new", object: "model", owned_by: "relay" }, { owned_by: "relay", object: "model", id: "gpt-new" }],
		has_more: true, last_id: "gpt-new", next: "https://official.example.test/models",
	});
	await withDiscovery("codex", codexConfig, net.fetch, async (runtime) => {
		assert.equal((await refresh(runtime, "codex")).errors.size, 0);
		assert.deepEqual(runtime.getModels("chameleon-codex").map((model) => model.id), ["gpt-new"]);
		assert.equal(net.requests.length, 1, "no undocumented pagination request");
	});
});

test("exact local ID and API capability references fill gaps without importing upstream identity", async () => {
	const net = network({ data: [{ id: "gpt-5" }, { id: "gpt-5.4" }, { id: "GPT-5" }, { id: "gpt-5-private" }] });
	await withDiscovery("codex", codexConfig, net.fetch, async (runtime) => {
		assert.equal((await refresh(runtime, "codex")).errors.size, 0);
		const gpt = runtime.getModel("chameleon-codex", "gpt-5")!;
		assert.equal(gpt.contextWindow, 400_000);
		assert.equal(gpt.maxTokens, 128_000);
		assert.equal(gpt.reasoning, true);
		assert.deepEqual(gpt.input, ["text", "image"]);
		assert.deepEqual(gpt.cost, { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 });
		assert.equal(gpt.thinkingLevelMap?.off, null);
		assert.equal(gpt.thinkingLevelMap?.xhigh, null);
		assert.ok(gpt.compat && "supportsStrictMode" in gpt.compat);
		assert.equal(gpt.compat.supportsStrictMode, true);
		assert.match(gpt.name, /参考费用/);
		assert.doesNotMatch(gpt.name, /能力未确认/);
		const newer = runtime.getModel("chameleon-codex", "gpt-5.4")!;
		assert.equal(newer.thinkingLevelMap?.xhigh, "xhigh");
		assert.deepEqual(newer.cost.tiers, [{ inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }]);
		for (const model of runtime.getModels("chameleon-codex")) {
			assert.equal(model.provider, "chameleon-codex");
			assert.equal(model.api, "openai-responses");
			assert.equal(model.baseUrl, codexConfig.baseUrl);
			assert.equal(model.headers, undefined);
		}
		for (const id of ["GPT-5", "gpt-5-private"]) {
			const unknown = runtime.getModel("chameleon-codex", id)!;
			assert.equal(unknown.contextWindow, 32_768);
			assert.equal(unknown.reasoning, false);
			assert.equal(unknown.thinkingLevelMap, undefined);
			assert.equal(unknown.compat, undefined);
			assert.match(unknown.name, /费用未知/);
		}
	});
});

test("safe adapter facts preserve zero rates and partial cost gaps, while Pi user overrides remain authoritative", async () => {
	const records: CatalogRecord[] = JSON.parse(`[
		{"id":"gpt-5","cost":{"input":0,"cacheWrite":0},"reasoning":false,"compat":{"supportsStrictMode":false,"allowedFallbackModels":[{"provider":"secret-upstream"}]},"headers":{"authorization":"secret"}},
		{"id":"gpt-new","contextWindow":1024,"maxTokens":512,"input":["text"],"reasoning":false,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}},
		{"id":"gpt-partial","cost":{"input":0}},
		{"id":"gpt-user","contextWindow":8192,"maxTokens":4096,"input":["text","image"],"reasoning":true}
	]`);
	await withDiscovery("codex", {
		...codexConfig, modelOverrides: { "gpt-user": { contextWindow: 2048, maxTokens: 256, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
	}, network().fetch, async (runtime) => {
		assert.equal((await refresh(runtime, "codex")).errors.size, 0);
		const known = runtime.getModel("chameleon-codex", "gpt-5")!;
		assert.deepEqual(known.cost, { input: 0, output: 10, cacheRead: 0.125, cacheWrite: 0 });
		assert.equal(known.reasoning, false);
		assert.ok(known.compat && "supportsStrictMode" in known.compat);
		assert.equal(known.compat.supportsStrictMode, false);
		assert.equal("allowedFallbackModels" in known.compat, false);
		assert.equal(known.headers, undefined);
		assert.match(known.name, /参考费用/);
		const free = runtime.getModel("chameleon-codex", "gpt-new")!;
		assert.deepEqual(free.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.doesNotMatch(free.name, /能力未确认|费用未知|参考费用/);
		assert.match(runtime.getModel("chameleon-codex", "gpt-partial")!.name, /费用未知.*不代表免费/);
		const user = runtime.getModel("chameleon-codex", "gpt-user")!;
		assert.equal(user.contextWindow, 2048);
		assert.equal(user.maxTokens, 256);
		assert.deepEqual(user.input, ["text"]);
		assert.equal(user.reasoning, false);
		assert.deepEqual([user.cost.input, user.cost.output, user.cost.cacheRead, user.cost.cacheWrite], [0, 0, 0, 0]);
	}, { records });
});

test("effective API context limits bound both referenced and API output budgets", () => {
	const models = buildModels("codex", codexConfig.baseUrl, [
		{ id: "gpt-5", contextWindow: 8_192 },
		{ id: "gpt-5.4", contextWindow: 2_048, maxTokens: 4_096 },
	]);
	assert.deepEqual(models.map(({ contextWindow, maxTokens }) => [contextWindow, maxTokens]), [[8_192, 8_192], [2_048, 2_048]]);
});

test("API thinking fields override exact references individually, including explicit null", () => {
	const [model] = buildModels("codex", codexConfig.baseUrl, [{
		id: "gpt-5.4", thinkingLevelMap: { high: "medium", xhigh: null },
	}]);
	assert.equal(model.thinkingLevelMap?.high, "medium");
	assert.equal(model.thinkingLevelMap?.xhigh, null);
	assert.equal(model.thinkingLevelMap?.off, "none", "unspecified fields still use the exact reference");
});

test("unsafe destinations and missing credentials fail before GET without revealing configuration secrets", async () => {
	for (const baseUrl of [
		"not-a-url-SYNTHETIC_SECRET", "file:///SYNTHETIC_SECRET", "ftp://relay.example.test/SYNTHETIC_SECRET",
		"https://SYNTHETIC_SECRET:password@relay.example.test", "https://relay.example.test?key=SYNTHETIC_SECRET",
		"https://relay.example.test#SYNTHETIC_SECRET",
	]) {
		const net = network({ data: [{ id: "gpt-new" }] });
		await withDiscovery("codex", { ...codexConfig, baseUrl }, net.fetch, async (runtime) => {
			const error = (await refresh(runtime, "codex")).errors.get("chameleon-codex");
			assert.ok(error instanceof CatalogFetchError);
			assert.equal(error.code, "unsafe-url");
			assert.doesNotMatch(error.message + error.stack + JSON.stringify(error), /SYNTHETIC_SECRET|password|relay\.example/);
			assert.equal(net.requests.length, 0, "do not send credentials to an unsafe destination");
			assert.deepEqual(runtime.getModels("chameleon-codex"), []);
		});
	}
	for (const apiKey of [undefined, "", "   ", "SYNTHETIC_SECRET\ninvalid"]) {
		const net = network({ data: [] });
		await assert.rejects(fetchCatalog("codex", { baseUrl: codexConfig.baseUrl, apiKey }, { fetch: net.fetch }), (error) => {
			assert.ok(error instanceof CatalogFetchError);
			assert.equal(error.code, "invalid-auth");
			assert.doesNotMatch(error.message + error.stack, /SYNTHETIC_SECRET/);
			return true;
		});
		assert.equal(net.requests.length, 0);
	}
});

test("HTTP, redirect, transport, header and JSON failures expose safe codes and never replace the previous catalog", async () => {
	const scenarios: { reply: () => Response | Promise<Response>; code: string; status?: number }[] = [
		...[401, 403, 429, 500].map((status) => ({ reply: () => new Response("SYNTHETIC_SECRET response body", { status }), code: "http-error", status })),
		{ reply: () => new Response("SYNTHETIC_SECRET", { status: 302, headers: { location: "https://SYNTHETIC_SECRET.example.test" } }), code: "unsafe-response" },
		{ reply: () => { throw new Error("https://relay.example.test/SYNTHETIC_SECRET apiKey=SYNTHETIC_SECRET"); }, code: "network-error" },
		{ reply: () => new Response("not json SYNTHETIC_SECRET"), code: "invalid-response" },
		{ reply: () => { const response = Response.json({ data: [{ id: "gpt-leaked" }] }); Object.defineProperty(response, "redirected", { value: true }); return response; }, code: "unsafe-response" },
		{ reply: () => { const response = Response.json({ data: [{ id: "gpt-leaked" }] }); Object.defineProperty(response, "url", { value: "https://other.example.test/SYNTHETIC_SECRET" }); return response; }, code: "unsafe-response" },
		{ reply: () => { const response = Response.json({ data: [{ id: "gpt-leaked" }] }); Object.defineProperty(response, "url", { value: "https://relay.example.test/other?secret=SYNTHETIC_SECRET" }); return response; }, code: "unsafe-response" },
	];
	for (const scenario of scenarios) {
		let first = true;
		const fetch: FetchFunction = async () => {
			if (first) { first = false; return Response.json({ data: [{ id: "gpt-old" }] }); }
			return scenario.reply();
		};
		await withDiscovery("codex", codexConfig, fetch, async (runtime) => {
			assert.equal((await refresh(runtime, "codex")).errors.size, 0);
			const error = (await refresh(runtime, "codex")).errors.get("chameleon-codex");
			assert.ok(error instanceof CatalogFetchError);
			assert.equal(error.code, scenario.code);
			assert.equal(error.httpStatus, scenario.status);
			assert.doesNotMatch(error.message + error.stack + JSON.stringify(error), /SYNTHETIC_SECRET|relay\.example|other\.example/);
			assert.equal(error.cause, undefined);
			assert.deepEqual(runtime.getModels("chameleon-codex").map((model) => model.id), ["gpt-old"]);
		});
	}
	await assert.rejects(fetchCatalog("codex", { ...codexConfig, headers: { "X-Tenant": "SYNTHETIC_SECRET\ninvalid" } }, { fetch: network().fetch }), (error) => {
		assert.ok(error instanceof CatalogFetchError);
		assert.equal(error.code, "invalid-auth");
		assert.doesNotMatch(error.message + error.stack, /SYNTHETIC_SECRET/);
		return true;
	});
});

class FakeClock implements DiscoveryClock {
	private time = 0;
	private timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>();
	now() { return this.time; }
	setTimeout(callback: () => void, milliseconds: number) {
		const handle = {} as ReturnType<typeof setTimeout>;
		this.timers.set(handle, { at: this.time + milliseconds, callback });
		return handle;
	}
	clearTimeout(handle: ReturnType<typeof setTimeout>) { this.timers.delete(handle); }
	advance(milliseconds: number) {
		this.time += milliseconds;
		for (const [handle, timer] of this.timers) {
			if (timer.at <= this.time) { this.timers.delete(handle); timer.callback(); }
		}
	}
	get pendingTimers() { return this.timers.size; }
}

test("one 15-second budget spans every page and cancels even transports or bodies that ignore signals", async () => {
	for (const kind of ["fetch", "body"] as const) {
		const clock = new FakeClock();
		const reached = deferred<void>();
		const fetchGate = deferred<Response>();
		const bodyGate = deferred<unknown>();
		let signal: AbortSignal | null | undefined;
		let page = 0;
		const fetch: FetchFunction = async (input, init = {}) => {
			signal = init.signal;
			if (++page === 1) {
				clock.advance(10_000);
				return Response.json({ data: [{ id: "claude-partial" }], has_more: true, last_id: "claude-partial" });
			}
			assert.equal(String(input), "https://relay.example.test/gateway/v1/v1/models?after_id=claude-partial");
			if (kind === "fetch") { reached.resolve(); return fetchGate.promise; }
			const response = Response.json({});
			Object.defineProperty(response, "url", { value: String(input) });
			response.json = () => { reached.resolve(); return bodyGate.promise; };
			return response;
		};
		const outcome = fetchCatalog("claude", codexConfig, { fetch, clock }).then(() => undefined, (error: unknown) => error);
		try {
			await Promise.race([reached.promise, outcome.then(() => { throw new Error("must wait for complete pages"); })]);
			clock.advance(4_999);
			assert.equal(signal?.aborted, false);
			clock.advance(1);
			assert.equal(signal?.aborted, true, "budget must not reset at the second page");
			const error = await outcome;
			assert.ok(error instanceof CatalogFetchError);
			assert.equal(error.code, "timeout");
			assert.equal(clock.pendingTimers, 0);
		} finally {
			fetchGate.resolve(Response.json({ data: [{ id: "claude-late" }], has_more: false }));
			bodyGate.resolve({ data: [{ id: "claude-late" }], has_more: false });
			await outcome;
		}
	}
	const pre = new AbortController();
	pre.abort("SYNTHETIC_SECRET");
	const net = network({ data: [] });
	await assert.rejects(fetchCatalog("codex", codexConfig, { fetch: net.fetch, signal: pre.signal, clock: new FakeClock() }), (error) => {
		assert.ok(error instanceof CatalogFetchError);
		assert.equal(error.code, "cancelled");
		assert.doesNotMatch(error.message + error.stack, /SYNTHETIC_SECRET/);
		return true;
	});
	assert.equal(net.requests.length, 0);
	for (const kind of ["fetch", "body"] as const) {
		const clock = new FakeClock();
		const caller = new AbortController();
		const reached = deferred<void>();
		const gate = deferred<Response>();
		const body = deferred<unknown>();
		let signal: AbortSignal | null | undefined;
		const fetch: FetchFunction = async (_input, init = {}) => {
			signal = init.signal;
			if (kind === "fetch") { reached.resolve(); return gate.promise; }
			const response = Response.json({});
			response.json = () => { reached.resolve(); return body.promise; };
			return response;
		};
		const outcome = fetchCatalog("codex", codexConfig, { fetch, clock, signal: caller.signal }).then(() => undefined, (error: unknown) => error);
		try {
			await reached.promise;
			caller.abort("SYNTHETIC_SECRET");
			assert.equal(signal?.aborted, true);
			const error = await outcome;
			assert.ok(error instanceof CatalogFetchError);
			assert.equal(error.code, "cancelled");
			assert.doesNotMatch(error.message + error.stack, /SYNTHETIC_SECRET/);
			assert.equal(clock.pendingTimers, 0);
		} finally {
			gate.resolve(Response.json({ data: [] }));
			body.resolve({ data: [] });
			await outcome;
		}
	}
});
