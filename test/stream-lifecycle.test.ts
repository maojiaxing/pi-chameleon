import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, type Api, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { claudeCodeStreamSimple } from "../src/claude/stream.ts";
import { codexStreamSimple } from "../src/codex/stream.ts";
import {
	API_KEY, SESSION_ID, BASE_URL, claudeModel, codexModel, context, capture,
	claudeTextResponse, codexTextResponse, object, array,
} from "./fixtures.ts";

type Stream = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream;
const adapters: { name: string; model: Model<Api>; stream: Stream; response: () => Response }[] = [
	{ name: "Claude", model: claudeModel(), stream: claudeCodeStreamSimple, response: claudeTextResponse },
	{ name: "Codex", model: codexModel(), stream: codexStreamSimple, response: codexTextResponse },
];

for (const adapter of adapters) {
	test(`${adapter.name}: onPayload hooks observe adaptation, mutate or replace once, and retain response hooks`, { timeout: 10_000 }, async () => {
		for (const replacement of [false, true]) {
			let calls = 0;
			let responses = 0;
			let events = 0;
			const mock = capture(adapter.response);
			const result = await adapter.stream(adapter.model, context(), {
				apiKey: API_KEY, reasoning: "high", fetch: mock.fetch,
				onPayload: async (value, model) => {
					calls++;
					assert.equal(model.id, adapter.model.id);
					const payload = object(value);
					if (adapter.name === "Codex") {
						assert.equal(payload.store, false);
						assert.ok(!("max_output_tokens" in payload));
					} else {
						assert.equal(array(payload.system).length, 2);
					}
					if (replacement) return { ...payload, metadata: { hook: "replaced" }, max_output_tokens: 48 };
					payload.metadata = { ...object(payload.metadata ?? {}), hook: "mutated" };
				},
				onResponse: (response) => { responses++; assert.equal(response.status, 200); },
				onProviderStreamEvent: () => { events++; },
			}).result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(calls, 1);
			assert.equal(responses, 1);
			assert.ok(events > 0);
			assert.equal(object(mock.requests[0].body.metadata).hook, replacement ? "replaced" : "mutated");
			if (replacement) assert.equal(mock.requests[0].body.max_output_tokens, 48);
		}
	});

	test(`${adapter.name}: throwing payload hooks and missing keys never send requests`, { timeout: 10_000 }, async () => {
		const mock = capture(adapter.response);
		const result = await adapter.stream(adapter.model, context(), {
			apiKey: API_KEY, fetch: mock.fetch, onPayload: async () => { throw new Error("fixture hook failure"); },
		}).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /fixture hook failure/);
		assert.equal(mock.requests.length, 0);
		assert.throws(() => adapter.stream(adapter.model, context(), { fetch: mock.fetch }), /No API key/);
	});

	test(`${adapter.name}: transport failure and HTTP overload terminate without automatic retries`, { timeout: 10_000 }, async () => {
		let calls = 0;
		const failed = await adapter.stream(adapter.model, context(), {
			apiKey: API_KEY, fetch: async () => { calls++; throw new Error("offline network failure"); },
		}).result();
		assert.equal(failed.stopReason, "error");
		assert.equal(calls, 1);
		const mock = capture(() => new Response(JSON.stringify({ error: { message: "Fixture overload", type: "overloaded_error" } }), {
			status: 503, headers: { "content-type": "application/json" },
		}));
		const overloaded = await adapter.stream(adapter.model, context(), { apiKey: API_KEY, fetch: mock.fetch }).result();
		assert.equal(overloaded.stopReason, "error");
		assert.match(overloaded.errorMessage ?? "", /Fixture overload/);
		assert.equal(mock.requests.length, 1);
	});

	test(`${adapter.name}: cancellation before and during transport resolves as aborted`, { timeout: 10_000 }, async () => {
		const before = new AbortController();
		before.abort();
		let calls = 0;
		const early = await adapter.stream(adapter.model, context(), {
			apiKey: API_KEY, signal: before.signal, fetch: async () => { calls++; return adapter.response(); },
		}).result();
		assert.equal(early.stopReason, "aborted");
		assert.equal(calls, 0);
		const during = new AbortController();
		let entered!: () => void;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const events = adapter.stream(adapter.model, context(), {
			apiKey: API_KEY, signal: during.signal,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				return new Promise<Response>((_resolve, reject) => {
					const abort = () => reject(new DOMException("Fixture cancelled", "AbortError"));
					if (request.signal.aborted) abort();
					else request.signal.addEventListener("abort", abort, { once: true });
					entered();
				});
			},
		});
		await started;
		during.abort();
		assert.equal((await events.result()).stopReason, "aborted");
	});
}

test("Codex request keeps explicit token caps and choice controls while omitting implicit defaults", { timeout: 10_000 }, async () => {
	for (const entry of [
		{ options: {}, expected: undefined },
		{ options: { maxTokens: 512 }, expected: 512 },
		{ options: { samplingParams: { max_output_tokens: 640 } }, expected: 640 },
	]) {
		const mock = capture(codexTextResponse);
		const result = await codexStreamSimple(codexModel(), context(), {
			...entry.options, apiKey: API_KEY, fetch: mock.fetch, reasoning: "high", temperature: 0.5, cacheRetention: "long",
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		const body = mock.requests[0].body;
		assert.equal(body.max_output_tokens, entry.expected);
		assert.ok(!("temperature" in body));
		assert.ok(!("prompt_cache_retention" in body));
		assert.ok(!("prompt_cache_options" in body));
	}
	const mock = capture(codexTextResponse);
	await codexStreamSimple({ ...codexModel(), samplingParams: { max_output_tokens: 768 } }, context(), {
		apiKey: API_KEY, fetch: mock.fetch,
		samplingParams: { tool_choice: { type: "function", name: "read" }, parallel_tool_calls: false, text: { verbosity: "low" }, include: ["output.encrypted_content"] },
	}).result();
	const body = mock.requests[0].body;
	assert.equal(body.max_output_tokens, 768);
	assert.deepEqual(body.tool_choice, { type: "function", name: "read" });
	assert.equal(body.parallel_tool_calls, false);
	assert.deepEqual(body.text, { verbosity: "low" });
	assert.deepEqual(body.include, ["output.encrypted_content", "reasoning.encrypted_content"]);
});

test("Codex uses the exact configured root URL and shares one path-free session across headers and caching", { timeout: 10_000 }, async () => {
	const mock = capture(codexTextResponse);
	for (let i = 0; i < 2; i++) {
		await codexStreamSimple({ ...codexModel(), baseUrl: BASE_URL }, context(), {
			apiKey: API_KEY, sessionId: "C:/synthetic/session.json", fetch: mock.fetch,
		}).result();
	}
	const [first, second] = mock.requests;
	assert.equal(first.url, `${BASE_URL}/responses`);
	assert.equal(first.headers.get("session-id"), second.headers.get("session-id"));
	assert.equal(first.headers.get("session-id"), first.body.prompt_cache_key);
	assert.match(String(first.body.prompt_cache_key), /^[a-f0-9-]{36}$/);
	const uncached = capture(codexTextResponse);
	await codexStreamSimple(codexModel(), context(), { apiKey: API_KEY, sessionId: SESSION_ID, cacheRetention: "none", fetch: uncached.fetch }).result();
	assert.ok(!("prompt_cache_key" in uncached.requests[0].body));
	assert.equal(uncached.requests[0].headers.get("session-id"), SESSION_ID);
});

test("Codex leading identity adaptation preserves quoted rules and actual later updates", { timeout: 10_000 }, async () => {
	const mock = capture(codexTextResponse);
	const prompt = "You are a coding assistant running inside pi, a coding agent harness. Keep rules.\nExample: You are a coding assistant running inside pi, a coding agent harness.";
	await codexStreamSimple(codexModel(), normalizeContext({
		systemPrompt: prompt, messages: [
			{ role: "user", content: "Keep my text", timestamp: 1 },
			{ role: "system", content: "Actual later rule update", timestamp: 2 },
		],
	}), { apiKey: API_KEY, fetch: mock.fetch }).result();
	const input = array(mock.requests[0].body.input).map(object);
	assert.ok(String(input[0].content).endsWith(prompt.replace("You are a coding assistant running inside pi, a coding agent harness. ", "")));
	assert.equal(input[1].role, "user");
	assert.ok(String(input[input.length - 1].content).includes("Actual later rule update"));
});
