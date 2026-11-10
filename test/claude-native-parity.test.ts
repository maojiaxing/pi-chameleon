import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { claudeCodeStream, claudeCodeStreamSimple } from "../src/claude/stream.ts";
import { API_KEY, capture, claudeTextResponse, object, array } from "./fixtures.ts";

const native = anthropicMessagesApi();
const base: Model<"anthropic-messages"> = {
	type: "chat", api: "anthropic-messages", provider: "chameleon-claude", baseUrl: "https://relay.example.test",
	id: "alias", name: "Display name", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 16384,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const conversation = normalizeContext({ systemPrompt: "Actual instructions", messages: [{ role: "user", content: "hi", timestamp: 1 }] });

test("raw and simple Claude entries preserve native reasoning fields across capability states", async () => {
	for (const compat of [undefined, { forceAdaptiveThinking: false }, { forceAdaptiveThinking: true }, { supportsMidConvoEffort: true }, { supportsMidConvoEffort: false }]) {
		for (const simple of [false, true]) {
			for (const enabled of [false, true]) {
				const model = { ...base, compat };
				const expected = capture(claudeTextResponse);
				const actual = capture(claudeTextResponse);
				const options = { apiKey: API_KEY, maxTokens: 1024, cacheRetention: "none" as const,
					thinkingEnabled: enabled, thinkingBudgetTokens: 512, effort: "high",
					reasoning: enabled ? "high" as const : undefined };
				const runNative = simple ? native.streamSimple : native.stream;
				const runAdapted = simple ? claudeCodeStreamSimple : claudeCodeStream;
				const [nativeResult, adaptedResult] = await Promise.all([
					runNative(model, conversation, { ...options, fetch: expected.fetch }).result(),
					runAdapted(model, conversation, { ...options, fetch: actual.fetch }).result(),
				]);
				assert.equal(adaptedResult.stopReason, nativeResult.stopReason, adaptedResult.errorMessage);
				assert.equal(actual.requests.length, expected.requests.length);
				for (const key of ["thinking", "output_config", "context_management", "max_tokens", "temperature"]) {
					assert.deepEqual(actual.requests[0].body[key], expected.requests[0].body[key], `${simple}/${enabled}/${JSON.stringify(compat)}: ${key}`);
				}
				const nativeEffort = array(expected.requests[0].body.messages).map(object).filter((m) => m.output_config).map((m) => m.output_config);
				const adaptedEffort = array(actual.requests[0].body.messages).map(object).filter((m) => m.output_config).map((m) => m.output_config);
				assert.deepEqual(adaptedEffort, nativeEffort);
			}
		}
	}
});

test("raw model IDs, suffix case and aliases survive successful and failed calls without fallback requests", async () => {
	for (const id of ["claude-opus-4-6", "claude-opus-4-6[1m]", "claude-opus-4-6[1M]", "ReLaY-Custom-Alias"]) {
		for (const fail of [false, true]) {
			const mock = capture(fail ? () => Response.json({ error: { type: "invalid_request_error", message: "synthetic rejection" } }, { status: 400 }) : claudeTextResponse);
			const model = { ...base, id, name: "Name does not determine ID", reasoning: false };
			const before = structuredClone(model);
			const result = await claudeCodeStreamSimple(model, conversation, { apiKey: API_KEY, fetch: mock.fetch }).result();
			assert.equal(result.stopReason, fail ? "error" : "stop");
			assert.equal(mock.requests.length, 1);
			assert.equal(mock.requests[0].body.model, id);
			assert.deepEqual(model, before);
		}
	}
});
