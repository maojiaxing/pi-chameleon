import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, type FetchFunction } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createDiscoveryProvider } from "../src/discovery/provider.ts";
import { createSnapshotRepository } from "../src/discovery/snapshot.ts";
import type { RelayFamily } from "../src/discovery/types.ts";
import { array, capture, claudeTextResponse, codexTextResponse, context, object, CLAUDE_BETAS } from "./fixtures.ts";

const originalClaude = getApiProvider("anthropic-messages")!;
const originalCodex = getApiProvider("openai-responses")!;
const key = "SYNTHETIC_ROUTING_RELAY_KEY";
const baseUrl = "https://synthetic-routing.invalid/gateway";
async function withEmptyBase(
	family: RelayFamily,
	run: (runtime: ModelRuntime, registry: ModelRegistry, discovery: ReturnType<typeof createDiscoveryProvider>) => Promise<void>,
	fetch?: FetchFunction,
) {
	const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-empty-routing-"));
	const id = `chameleon-${family}`;
	const api = family === "claude" ? "anthropic-messages" : "openai-responses";
	let ready!: () => void;
	const initialized = new Promise<void>((resolve) => { ready = resolve; });
	let registry: ModelRegistry | undefined;
	const discovery = createDiscoveryProvider(family, {
		repository: createSnapshotRepository({ directory: join(directory, "cache") }), fetch,
		resolveAccess: async () => {
			const resolved = await registry?.getProviderAuth(id);
			return resolved ? { baseUrl, apiKey: resolved.auth.apiKey, headers: resolved.auth.headers } : undefined;
		},
		onChange: (state) => { if (state.status === "unconfigured") ready(); },
	});
	try {
		const path = join(directory, "models.json");
		const explicit = { id: `private-${family}`, api, name: "Explicit private chat", reasoning: true,
			input: ["text"], contextWindow: 16_384, maxTokens: 2_048,
			...(family === "claude" ? { compat: { forceAdaptiveThinking: true } } : {}),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		await writeFile(path, JSON.stringify({ providers: {
			[id]: { baseUrl, apiKey: key, models: [explicit] },
			[`ordinary-${family}`]: { baseUrl, apiKey: "SYNTHETIC_ORDINARY_KEY", models: [explicit] },
		} }));
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
			modelsPath: path, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
		runtime.registerNativeProvider(discovery.provider);
		await initialized;
		await new Promise<void>((resolve) => setImmediate(resolve));
		registry = new ModelRegistry(runtime);
		assert.deepEqual(discovery.provider.getModels(), [], "there is no sentinel or synthetic baseline model");
		assert.deepEqual(runtime.getModels(id).map((model) => model.id), [`private-${family}`], "only the JSON explicit model is composed");
		await run(runtime, registry, discovery);
	} finally {
		discovery.dispose();
		await rm(directory, { recursive: true, force: true });
	}
}

test("an explicit Claude JSON model uses the CLI wrapper when the native base catalog is truly empty", { timeout: 20_000 }, async () => {
	await withEmptyBase("claude", async (runtime) => {
		const model = runtime.getModel("chameleon-claude", "private-claude")!;
		const mock = capture(claudeTextResponse);
		const result = await runtime.completeSimple(model, context(), {
			fetch: mock.fetch, reasoning: "high", maxTokens: 777,
			headers: { Authorization: "Bearer SYNTHETIC_FOREIGN_KEY", Cookie: "SYNTHETIC_COOKIE" },
		});
		assert.equal(result.stopReason, "stop", result.errorMessage);
		const request = mock.requests[0];
		assert.match(request.headers.get("user-agent")!, /^claude-cli\/2\.1\.302/);
		assert.equal(request.url, `${baseUrl}/v1/messages?beta=true`);
		assert.equal(request.redirect, "error");
		assert.equal(request.headers.get("x-api-key"), key);
		for (const name of ["authorization", "cookie", "originator", "chatgpt-account-id", "proxy-authorization"]) assert.equal(request.headers.get(name), null);
		assert.equal(request.headers.get("anthropic-beta"), CLAUDE_BETAS.join(","));
		assert.equal(request.body.model, "private-claude");
		assert.equal(request.body.max_tokens, 777);
		assert.equal(object(request.body.output_config).effort, "high");
		assert.equal(array(request.body.system).length, 2);
		assert.match(JSON.stringify(request.body.system), /You are Claude Code/);
		assert.match(JSON.stringify(request.body), /Actual Pi context/);
		assert.doesNotMatch(JSON.stringify(request.body), /SYNTHETIC_FOREIGN_KEY|SYNTHETIC_COOKIE/);
	});
});

test("an explicit Codex JSON model uses the CLI wrapper with an empty base and preserves raw and simple options", { timeout: 20_000 }, async () => {
	await withEmptyBase("codex", async (runtime) => {
		const model = runtime.getModel("chameleon-codex", "private-codex")!;
		for (const raw of [false, true]) {
			const mock = capture(codexTextResponse);
			const events = raw
				? runtime.stream(model, context(), { fetch: mock.fetch, reasoningEffort: "high", maxTokens: 654 })
				: runtime.streamSimple(model, context(), { fetch: mock.fetch, reasoning: "high", maxTokens: 777 });
			const result = await events.result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
			const request = mock.requests[0];
			assert.equal(request.headers.get("originator"), "codex_cli_rs");
			assert.equal(request.headers.get("version"), "0.166.0");
			assert.equal(request.headers.get("authorization"), `Bearer ${key}`);
			for (const name of ["x-api-key", "cookie", "anthropic-beta", "chatgpt-account-id", "proxy-authorization"]) assert.equal(request.headers.get(name), null);
			assert.equal(request.url, `${baseUrl}/responses`);
			assert.equal(request.redirect, "error");
			assert.equal(request.body.model, "private-codex");
			assert.equal(request.body.max_output_tokens, raw ? 654 : 777);
			assert.equal(object(request.body.reasoning).effort, "high");
			assert.match(JSON.stringify(request.body.input), /Codex/);
			assert.match(JSON.stringify(request.body), /Actual Pi context/);
		}
	});
});

test("empty-base Claude raw streaming keeps caller effort and output cap", { timeout: 20_000 }, async () => {
	await withEmptyBase("claude", async (runtime) => {
		const model = runtime.getModel("chameleon-claude", "private-claude")!;
		const mock = capture(claudeTextResponse);
		const result = await runtime.stream(model, context(), { fetch: mock.fetch, thinkingEnabled: true, effort: "medium", maxTokens: 654 }).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.match(mock.requests[0].headers.get("user-agent")!, /^claude-cli\/2\.1\.302/);
		assert.equal(mock.requests[0].body.max_tokens, 654);
		assert.equal(object(mock.requests[0].body.output_config).effort, "medium");
		assert.equal(array(mock.requests[0].body.system).length, 2);
	});
});

for (const family of ["claude", "codex"] as const) {
	test(`${family} explicit routing survives a permission suspension and an empty successful automatic catalog`, { timeout: 20_000 }, async () => {
		const responses = [
			Response.json({ data: [{ id: family === "claude" ? "claude-automatic" : "gpt-automatic" }], ...(family === "claude" ? { has_more: false } : {}) }),
			new Response("SYNTHETIC_DENIED", { status: 403 }),
			Response.json({ data: [], ...(family === "claude" ? { has_more: false } : {}) }),
		];
		await withEmptyBase(family, async (runtime, registry, discovery) => {
			const id = `chameleon-${family}`;
			await registry.refresh({ providers: [id], allowNetwork: true, force: true });
			assert.equal(discovery.provider.getModels().length, 1);
			for (let turn = 0; turn < 2; turn++) {
				await registry.refresh({ providers: [id], allowNetwork: true, force: true });
				assert.deepEqual(discovery.provider.getModels(), []);
				assert.deepEqual(runtime.getModels(id).map((model) => model.id), [`private-${family}`]);
				const mock = capture(family === "claude" ? claudeTextResponse : codexTextResponse);
				const result = await runtime.streamSimple(runtime.getModel(id, `private-${family}`)!, context(), { fetch: mock.fetch, maxTokens: 321 }).result();
				assert.equal(result.stopReason, "stop", result.errorMessage);
				assert.equal(mock.requests.length, 1);
				assert.equal(mock.requests[0].redirect, "error");
				if (family === "claude") {
					assert.match(mock.requests[0].headers.get("user-agent")!, /^claude-cli\/2\.1\.302/);
					assert.equal(array(mock.requests[0].body.system).length, 2);
				} else assert.equal(mock.requests[0].headers.get("originator"), "codex_cli_rs");
			}
		}, async () => { assert.ok(responses.length); return responses.shift()!; });
	});

	test(`${family} non-Chameleon fallback remains the actual original native API for raw and simple streams`, { timeout: 20_000 }, async () => {
		await withEmptyBase(family, async (runtime) => {
			const original = family === "claude" ? originalClaude : originalCodex;
			const model = runtime.getModel(`ordinary-${family}`, `private-${family}`)!;
			for (const raw of [false, true]) {
				const expected = capture(family === "claude" ? claudeTextResponse : codexTextResponse);
				const actual = capture(family === "claude" ? claudeTextResponse : codexTextResponse);
				const options = { apiKey: "SYNTHETIC_ORDINARY_KEY", maxTokens: 543 };
				const native = raw ? original.stream(model, context(), { ...options, fetch: expected.fetch })
					: original.streamSimple(model, context(), { ...options, fetch: expected.fetch });
				assert.equal((await native.result()).stopReason, "stop");
				const routed = raw ? runtime.stream(model, context(), { ...options, fetch: actual.fetch })
					: runtime.streamSimple(model, context(), { ...options, fetch: actual.fetch });
				assert.equal((await routed.result()).stopReason, "stop");
				assert.equal(actual.requests[0].url, expected.requests[0].url);
				assert.equal(actual.requests[0].headers.get("user-agent"), expected.requests[0].headers.get("user-agent"));
				assert.equal(actual.requests[0].headers.get("originator"), expected.requests[0].headers.get("originator"));
				assert.deepEqual(actual.requests[0].body, expected.requests[0].body);
				assert.doesNotMatch(JSON.stringify([...actual.requests[0].headers]) + JSON.stringify(actual.requests[0].body), /SYNTHETIC_ROUTING_RELAY_KEY|claude-cli|codex_cli_rs|You are Claude Code/);
			}
		});
	});
}

test("public API routing remains single-layer across provider factories and module reloads", { timeout: 20_000 }, async () => {
	await withEmptyBase("claude", async (runtime) => {
		const beforeClaude = getApiProvider("anthropic-messages");
		const beforeCodex = getApiProvider("openai-responses");
		for (let turn = 0; turn < 3; turn++) {
			const module = await import(`${new URL("../src/discovery/routing.ts", import.meta.url).href}?syntheticReload=${turn}`);
			module.installChameleonRouting();
			const extra = createDiscoveryProvider("codex", { repository: createSnapshotRepository({ directory: join(tmpdir(), "synthetic-unused-routing-cache") }), resolveAccess: async () => undefined });
			extra.dispose();
		}
		assert.equal(getApiProvider("anthropic-messages"), beforeClaude);
		assert.equal(getApiProvider("openai-responses"), beforeCodex);
		const mock = capture(claudeTextResponse);
		assert.equal((await runtime.streamSimple(runtime.getModel("chameleon-claude", "private-claude")!, context(), { fetch: mock.fetch }).result()).stopReason, "stop");
		assert.equal(mock.requests.length, 1);
		assert.equal(array(mock.requests[0].body.system).length, 2);
	});
});
