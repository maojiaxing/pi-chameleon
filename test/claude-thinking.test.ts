import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { claudeCodeStream, claudeCodeStreamSimple } from "../src/claude/stream.ts";
import { capture, claudeTextResponse, object } from "./fixtures.ts";

// Replay a native models.json model whose capability metadata has no adaptive flag.
// Unlike the transport fixtures, this input does not pre-fill forceAdaptiveThinking.
const configuredModel: Model<"anthropic-messages"> = {
	type: "chat", api: "anthropic-messages", provider: "chameleon-claude",
	id: "claude-opus-4-6", name: "Claude Opus 4.6", baseUrl: "https://relay.example.test",
	reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 64_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const conversation = normalizeContext({
	messages: [{ role: "user", content: "Reply ok.", timestamp: 1 }],
});

test("Claude models without adaptive metadata emit adaptive thinking instead of a token budget", { timeout: 5_000 }, async () => {
	const mock = capture(claudeTextResponse);
	const result = await claudeCodeStreamSimple(configuredModel, conversation, {
		apiKey: "synthetic-offline-key", reasoning: "high", fetch: mock.fetch,
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(mock.requests.length, 1);
	assert.deepEqual(mock.requests[0].body.thinking, { type: "adaptive", display: "updates" });
	assert.equal("budget_tokens" in object(mock.requests[0].body.thinking), false);
	assert.deepEqual(mock.requests[0].body.output_config, { effort: "high" });
});

for (const id of ["claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-5-5", "claude-sonnet-5-5"]) {
	test(`known adaptive model ${id} needs no manually prefilled compat`, { timeout: 5_000 }, async () => {
		const model = { ...configuredModel, id, compat: { supportsTemperature: false } };
		const before = structuredClone(model);
		const mock = capture(claudeTextResponse);
		const result = await claudeCodeStreamSimple(model, conversation, {
			apiKey: "synthetic-offline-key", reasoning: "medium", maxTokens: 2048, fetch: mock.fetch,
			onPayload: (payload, wireModel) => {
				assert.ok(wireModel.compat && "forceAdaptiveThinking" in wireModel.compat);
				assert.equal(wireModel.compat.forceAdaptiveThinking, true, "select the native adaptive branch before payload adaptation");
				assert.deepEqual(object(payload).thinking, { type: "adaptive", display: "updates" });
			},
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.deepEqual(mock.requests[0].body.output_config, { effort: "medium" });
		assert.equal(mock.requests[0].body.max_tokens, 2048, "adaptive must not run the budget/cap adjustment");
		assert.deepEqual(model, before, "request defaults must not mutate native configuration");
	});
}

test("raw Claude stream receives the same adaptive default without reinterpreting its effort", { timeout: 5_000 }, async () => {
	const mock = capture(claudeTextResponse);
	const options = {
		apiKey: "synthetic-offline-key", thinkingEnabled: true, effort: "low", thinkingBudgetTokens: 4096,
		maxTokens: 2048, fetch: mock.fetch,
	};
	const result = await claudeCodeStream(configuredModel, conversation, options).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.deepEqual(mock.requests[0].body.thinking, { type: "adaptive", display: "updates" });
	assert.deepEqual(mock.requests[0].body.output_config, { effort: "low" });
	assert.equal(mock.requests[0].body.max_tokens, 2048);
});

test("explicit forceAdaptiveThinking:false preserves the native budget branch", { timeout: 5_000 }, async () => {
	const model = { ...configuredModel, compat: { forceAdaptiveThinking: false } };
	const before = structuredClone(model);
	const mock = capture(claudeTextResponse);
	const result = await claudeCodeStreamSimple(model, conversation, {
		apiKey: "synthetic-offline-key", reasoning: "high", fetch: mock.fetch,
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.deepEqual(mock.requests[0].body.thinking, { type: "enabled", budget_tokens: 16384, display: "summarized" });
	assert.equal("output_config" in mock.requests[0].body, false);
	assert.deepEqual(model, before);
});

for (const id of ["claude-sonnet-4-5", "relay-unknown-model"]) {
	test(`non-adaptive or unknown model ${id} retains budget thinking`, { timeout: 5_000 }, async () => {
		const mock = capture(claudeTextResponse);
		const result = await claudeCodeStreamSimple({ ...configuredModel, id }, conversation, {
			apiKey: "synthetic-offline-key", reasoning: "high", fetch: mock.fetch,
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.deepEqual(mock.requests[0].body.thinking, { type: "enabled", budget_tokens: 16384, display: "summarized" });
	});
}

test("an adaptive default does not enable reasoning that the caller or model disabled", { timeout: 5_000 }, async () => {
	for (const reasoning of [true, false]) {
		const mock = capture(claudeTextResponse);
		const result = await claudeCodeStreamSimple({ ...configuredModel, reasoning }, conversation, {
			apiKey: "synthetic-offline-key", ...(reasoning ? {} : { reasoning: "high" as const }), fetch: mock.fetch,
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.deepEqual(mock.requests[0].body.thinking, reasoning ? { type: "disabled" } : undefined);
		assert.equal("output_config" in mock.requests[0].body, false);
	}
});

test("explicit adaptive metadata and native thinking maps work for arbitrary relay IDs", { timeout: 5_000 }, async () => {
	const mock = capture(claudeTextResponse);
	const result = await claudeCodeStreamSimple({
		...configuredModel, id: "relay-private-model", compat: { forceAdaptiveThinking: true },
		thinkingLevelMap: { xhigh: "max" },
	}, conversation, { apiKey: "synthetic-offline-key", reasoning: "xhigh", fetch: mock.fetch }).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.deepEqual(mock.requests[0].body.thinking, { type: "adaptive", display: "updates" });
	assert.deepEqual(mock.requests[0].body.output_config, { effort: "max" });
});
