import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createChameleonExtension } from "../src/index.ts";
import { createSnapshotRepository } from "../src/discovery/snapshot.ts";
import { capture, claudeTextResponse, codexTextResponse, context, object, CLAUDE_FIXTURE_MODELS, CODEX_FIXTURE_MODELS, codexModel } from "./fixtures.ts";

// Chat regressions use explicit test-only definitions, never a production member catalog.
function syntheticConfig(config: unknown) {
	const result = structuredClone(config) as { providers?: Record<string, Record<string, unknown>> };
	for (const [id, provider] of Object.entries(result.providers ?? {})) {
		const fixtures = id === "chameleon-claude" ? CLAUDE_FIXTURE_MODELS : id === "chameleon-codex" ? CODEX_FIXTURE_MODELS : [];
		const api = id === "chameleon-claude" ? "anthropic-messages" : "openai-responses";
		const definitions = new Map<string, Record<string, unknown>>(fixtures.map((fixture) => [fixture.id, { ...fixture, api }]));
		const declared = provider.models ?? [];
		assert.ok(Array.isArray(declared));
		for (const definition of declared) {
			const model = object(definition);
			assert.equal(typeof model.id, "string");
			definitions.set(model.id as string, { ...definitions.get(model.id as string), ...model });
		}
		provider.models = [...definitions.values()];
	}
	return result;
}

async function withRuntime(
	config: unknown,
	run: (runtime: ModelRuntime, path: string, credentials: InMemoryCredentialStore, providers: Provider[]) => Promise<void>,
	options: { fixtureModels?: boolean; discoveredModels?: readonly string[] } = {},
) {
	const dir = await mkdtemp(join(tmpdir(), "pi-chameleon-models-config-"));
	const path = join(dir, "models.json");
	const credentials = new InMemoryCredentialStore();
	let session: AgentSession | undefined;
	try {
		await writeFile(path, JSON.stringify(options.fixtureModels === false ? config : syntheticConfig(config)));
		const runtime = await ModelRuntime.create({
			credentials, modelsPath: path, modelsStore: new InMemoryModelsStore(),
			allowModelNetwork: false, refreshOnCreate: false,
		});
		const settings = SettingsManager.inMemory({ retry: { enabled: false }, cacheWarming: "off" });
		const registry = new ModelRegistry(runtime);
		const configured = Object.values((config as { providers?: Record<string, { baseUrl?: string; apiKey?: string }> }).providers ?? {});
		const expectedRequests = configured.filter((provider) => provider.baseUrl && provider.apiKey).length;
		let requests = 0;
		let resolveReady!: () => void;
		const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
		if (!expectedRequests) resolveReady();
		const loader = new DefaultResourceLoader({
			cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true,
			noContextFiles: true, noPromptTemplates: true,
			extensionFactories: [createChameleonExtension({
				repository: createSnapshotRepository({ directory: join(dir, "catalogs") }),
				fetch: async () => {
					if (++requests === expectedRequests) resolveReady();
					const ids = options.discoveredModels ?? [...CLAUDE_FIXTURE_MODELS, ...CODEX_FIXTURE_MODELS].map(({ id }) => id);
					return Response.json({ data: ids.map((id) => ({ id })), has_more: false });
				},
			})],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd: dir, agentDir: dir, modelRuntime: runtime, resourceLoader: loader, settingsManager: settings,
			sessionManager: SessionManager.inMemory(dir), model: codexModel(), noTools: "all",
		}));
		await new Promise<void>((resolve) => setImmediate(resolve));
		await runtime.refresh({ providers: ["chameleon-codex", "chameleon-claude"], allowNetwork: false });
		await session.bindExtensions({ mode: "print" });
		await ready;
		// Join already-armed startup GETs instead of racing its background force with another force.
		await registry.refresh({ providers: ["chameleon-codex", "chameleon-claude"], allowNetwork: true });
		const providers = ["chameleon-claude", "chameleon-codex"].map((id) => runtime.getRegisteredNativeProvider(id)!);
		await run(runtime, path, credentials, providers);
	} finally {
		if (session) { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		await rm(dir, { recursive: true, force: true, maxRetries: 3 });
	}
}

const shared = {
	providers: {
		"chameleon-claude": { baseUrl: "https://relay.example.com", apiKey: "fixture-shared-key" },
		"chameleon-codex": { baseUrl: "https://relay.example.com/v1", apiKey: "fixture-shared-key" },
	},
};

test("native registration has no environment gate, credentials or guessed upstream", async () => {
	await withRuntime({}, async (runtime, _path, _credentials, providers) => {
		assert.deepEqual(providers.map((p) => p.id), ["chameleon-claude", "chameleon-codex"]);
		for (const provider of providers) {
			assert.equal(provider.auth.oauth, undefined);
			assert.deepEqual(provider.getModels(), []);
			assert.ok(provider.refreshModels);
			assert.equal(provider.baseUrl, undefined);
		}
		assert.equal(runtime.getModels("chameleon-claude").length, 0);
		assert.equal(runtime.getModels("chameleon-codex").length, 0);
		assert.equal((await runtime.getAvailable("chameleon-claude")).length, 0);
		assert.equal((await runtime.getAvailable("chameleon-codex")).length, 0);
	});
});

test("Pi models.json alone configures both CLI adapters with the same relay key", { timeout: 20_000 }, async () => {
	await withRuntime(shared, async (runtime) => {
		assert.equal(runtime.getError(), undefined);
		for (const [id, modelId, response, endpoint, authHeader] of [
			["chameleon-claude", "claude-opus-4-6", claudeTextResponse, "https://relay.example.com/v1/messages?beta=true", "x-api-key"],
			["chameleon-codex", "gpt-5.3-codex", codexTextResponse, "https://relay.example.com/v1/responses", "authorization"],
		] as const) {
			assert.equal((await runtime.getAvailable(id)).length, 3);
			const model = runtime.getModel(id, modelId);
			assert.ok(model);
			const mock = capture(response);
			const result = await runtime.completeSimple(model, context(), { fetch: mock.fetch, reasoning: "high" });
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(mock.requests[0].url, endpoint);
			assert.equal(mock.requests[0].headers.get(authHeader), authHeader === "authorization" ? "Bearer fixture-shared-key" : "fixture-shared-key");
			assert.equal(mock.requests[0].headers.get("user-agent")?.includes("pi/"), false);
		}
	});
});

test("explicit native Claude models without adaptive metadata retain native budget thinking", { timeout: 20_000 }, async () => {
	const definition = {
		id: "claude-opus-4-6", name: "Explicit Claude", reasoning: true, input: ["text"],
		contextWindow: 200_000, maxTokens: 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	await withRuntime({ providers: { "chameleon-claude": {
		api: "anthropic-messages", baseUrl: "https://relay.example.test", apiKey: "synthetic-offline-key",
		models: [definition],
	} } }, async (runtime, path) => {
		const model = runtime.getModel("chameleon-claude", definition.id)!;
		assert.ok(model);
		assert.equal(model.compat && "forceAdaptiveThinking" in model.compat ? model.compat.forceAdaptiveThinking : undefined,
			undefined, "no fixture or discovered capability may mask the missing field");
		const configBefore = await readFile(path, "utf8");
		const modelBefore = structuredClone(model);
		const mock = capture(claudeTextResponse);
		const result = await runtime.completeSimple(model, context(), { fetch: mock.fetch, reasoning: "high", thinkingBudgets: { high: 2048 }, maxTokens: 2048 });
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(mock.requests.length, 1);
		assert.deepEqual(mock.requests[0].body.thinking, { type: "enabled", budget_tokens: 2048, display: "summarized" });
		assert.equal("output_config" in mock.requests[0].body, false);
		assert.equal(mock.requests[0].body.max_tokens, 4096, "native budget adjustment reserves output tokens");
		assert.deepEqual(model, modelBefore);
		assert.equal(await readFile(path, "utf8"), configBefore, "defaults must not rewrite models.json");
	}, { fixtureModels: false, discoveredModels: [] });
});

test("native Claude provider and model compat overrides keep an explicit adaptive false", { timeout: 20_000 }, async () => {
	for (const overrides of [
		{ compat: { forceAdaptiveThinking: false } },
		{ compat: { forceAdaptiveThinking: true }, modelOverrides: { "claude-opus-4-6": { compat: { forceAdaptiveThinking: false } } } },
	]) {
		await withRuntime({ providers: { "chameleon-claude": {
			api: "anthropic-messages", baseUrl: "https://relay.example.test", apiKey: "synthetic-offline-key",
			models: [{ id: "claude-opus-4-6", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 }],
			...overrides,
		} } }, async (runtime) => {
			const model = runtime.getModel("chameleon-claude", "claude-opus-4-6")!;
			assert.ok(model.compat && "forceAdaptiveThinking" in model.compat);
			assert.equal(model.compat.forceAdaptiveThinking, false);
			const mock = capture(claudeTextResponse);
			const result = await runtime.completeSimple(model, context(), { fetch: mock.fetch, reasoning: "high" });
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.deepEqual(mock.requests[0].body.thinking, { type: "enabled", budget_tokens: 16384, display: "summarized" });
			assert.equal("output_config" in mock.requests[0].body, false);
		}, { fixtureModels: false, discoveredModels: [] });
	}
});

test("native authHeader:true lets both protocols use Bearer without an extension field", { timeout: 20_000 }, async () => {
	const config = structuredClone(shared);
	Object.assign(config.providers["chameleon-claude"], { authHeader: true, headers: { "X-Relay-Tag": "from-models-json" } });
	await withRuntime(config, async (runtime) => {
		const model = runtime.getModel("chameleon-claude", "claude-opus-4-6")!;
		const mock = capture(claudeTextResponse);
		const result = await runtime.completeSimple(model, context(), { fetch: mock.fetch });
		assert.equal(result.stopReason, "stop", result.errorMessage);
		const headers = mock.requests[0].headers;
		assert.equal(headers.get("authorization"), "Bearer fixture-shared-key");
		assert.equal(headers.get("x-api-key"), null);
		assert.equal(headers.get("x-relay-tag"), "from-models-json");
	});
});

test("models and modelOverrides keep native merge semantics and custom streaming", { timeout: 20_000 }, async () => {
	await withRuntime({ providers: { "chameleon-codex": {
		baseUrl: "https://separate.example.com/gateway/openai", apiKey: "codex-fixture",
		models: [{ id: "relay-codex-model", api: "openai-responses", name: "Relay Codex", reasoning: true }],
		modelOverrides: { "gpt-5.3-codex": { name: "Custom label", maxTokens: 8192, samplingParams: { max_output_tokens: 8192 } } },
	} } }, async (runtime) => {
		assert.equal(runtime.getModels("chameleon-codex").length, 4);
		const model = runtime.getModel("chameleon-codex", "gpt-5.3-codex")!;
		assert.equal(model.name, "Custom label");
		assert.equal(model.maxTokens, 8192);
		assert.equal(model.contextWindow, 400_000);
		assert.equal(model.thinkingLevelMap?.max, null);
		assert.equal(runtime.getModel("chameleon-codex", "gpt-5.5")?.cost.tiers?.[0]?.output, 45);
		const mock = capture(codexTextResponse);
		assert.equal((await runtime.completeSimple(model, context(), { fetch: mock.fetch })).stopReason, "stop");
		assert.equal(mock.requests[0].body.max_output_tokens, 8192);
		const custom = runtime.getModel("chameleon-codex", "relay-codex-model")!;
		assert.equal((await runtime.completeSimple(custom, context(), { fetch: mock.fetch })).stopReason, "stop");
		assert.equal(mock.requests[1].url, "https://separate.example.com/gateway/openai/responses");
		assert.equal(mock.requests[1].body.model, "relay-codex-model");
		assert.equal(mock.requests[1].headers.get("originator"), "codex_cli_rs");
	});
});

test("Pi refresh reloads models.json and native credential precedence stays intact", { timeout: 20_000 }, async () => {
	await withRuntime(shared, async (runtime, path, credentials) => {
		await credentials.modify("chameleon-codex", async () => ({ type: "api_key", key: "stored-fixture-key" }));
		const mock = capture(codexTextResponse);
		let model = runtime.getModel("chameleon-codex", "gpt-5.3-codex")!;
		await runtime.completeSimple(model, context(), { fetch: mock.fetch });
		assert.equal(mock.requests[0].headers.get("authorization"), "Bearer stored-fixture-key");
		await runtime.completeSimple(model, context(), { fetch: mock.fetch, apiKey: "runtime-fixture-key" });
		assert.equal(mock.requests[1].headers.get("authorization"), "Bearer runtime-fixture-key");
		await credentials.delete("chameleon-codex");
		await writeFile(path, JSON.stringify(syntheticConfig({ providers: { "chameleon-codex": { baseUrl: "https://new-relay.example.com/openai", apiKey: "new-fixture-key" } } })));
		const refreshed = await runtime.refresh({ allowNetwork: true, force: true, providers: ["chameleon-codex"] });
		assert.equal(refreshed.errors.size, 0);
		model = runtime.getModel("chameleon-codex", "gpt-5.3-codex")!;
		await runtime.completeSimple(model, context(), { fetch: mock.fetch });
		assert.equal(mock.requests[2].url, "https://new-relay.example.com/openai/responses");
		assert.equal(mock.requests[2].headers.get("authorization"), "Bearer new-fixture-key");
	});
});

test("native raw stream retains provider-specific reasoning options and disguise", { timeout: 20_000 }, async () => {
	await withRuntime(shared, async (runtime) => {
		const codex = runtime.getModel("chameleon-codex", "gpt-5.3-codex")!;
		assert.equal(codex.api, "openai-responses");
		const mock = capture(codexTextResponse);
		const result = await runtime.stream(codex, context(), { fetch: mock.fetch, reasoningEffort: "high", maxTokens: 256 }).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(object(mock.requests[0].body.reasoning).effort, "high");
		assert.equal(mock.requests[0].body.max_output_tokens, 256);
		const claude = runtime.getModel("chameleon-claude", "claude-opus-4-6")!;
		const anthropic = capture(claudeTextResponse);
		const message = await runtime.stream(claude, context(), { fetch: anthropic.fetch, thinkingEnabled: true, effort: "high" }).result();
		assert.equal(message.stopReason, "stop", message.errorMessage);
		assert.equal(object(anthropic.requests[0].body.output_config).effort, "high");
	});
});

test("apiKey without baseUrl fails closed rather than guessing an upstream", { timeout: 20_000 }, async () => {
	await withRuntime({ providers: { "chameleon-codex": { apiKey: "fixture-key" } } }, async (_runtime, _path, _credentials, providers) => {
		const model = { ...codexModel(), baseUrl: "" };
		const mock = capture(codexTextResponse);
		// A missing base URL is not a valid models.json definition. Exercise the native public stream with a synthetic model.
		assert.throws(() => providers[1].streamSimple(model, context(), { fetch: mock.fetch, apiKey: "fixture-key" }), /baseUrl.*models.json/);
		assert.equal(mock.requests.length, 0);
	});
});

test("README provider examples stay in sync with the copyable models.json files", async () => {
	const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
	const configs = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)]
		.map((match) => JSON.parse(match[1]))
		.filter((config) => config.providers !== undefined);
	const examples = await Promise.all(["models.json", "models-bearer.json", "models-separate.json"].map(async (name) =>
		JSON.parse(await readFile(new URL(`../examples/${name}`, import.meta.url), "utf8")),
	));
	assert.deepEqual(configs, examples);
});

test("model-level baseUrl overrides and native apiKey interpolation require no extension config", { timeout: 20_000 }, async () => {
	await withRuntime({ providers: { "chameleon-codex": {
		baseUrl: "https://provider.example.com/v1",
		apiKey: "$$literal-fixture-key",
		models: [{ id: "gpt-5.3-codex", baseUrl: "https://model.example.com/custom", reasoning: true }],
	} } }, async (runtime) => {
		const model = runtime.getModel("chameleon-codex", "gpt-5.3-codex")!;
		assert.equal(model.baseUrl, "https://model.example.com/custom");
		assert.equal(runtime.getModels("chameleon-codex").length, 3);
		const mock = capture(codexTextResponse);
		const result = await runtime.completeSimple(model, context(), { fetch: mock.fetch });
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.equal(mock.requests[0].url, "https://model.example.com/custom/responses");
		assert.equal(mock.requests[0].headers.get("authorization"), "Bearer $literal-fixture-key");
	});
});

test("example models.json files are consumed by the real Pi runtime", { timeout: 20_000 }, async () => {
	for (const name of ["models.json", "models-bearer.json", "models-separate.json"]) {
		const example = JSON.parse(await readFile(new URL(`../examples/${name}`, import.meta.url), "utf8"));
		await withRuntime(example, async (runtime) => {
			assert.equal(runtime.getError(), undefined);
			assert.equal((await runtime.getAvailable("chameleon-claude")).length, 3);
			assert.equal((await runtime.getAvailable("chameleon-codex")).length, 3);
		});
	}
});
