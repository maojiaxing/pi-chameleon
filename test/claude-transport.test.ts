import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { claudeCodeStream, claudeCodeStreamSimple } from "../src/claude/stream.ts";
import {
 API_KEY, SESSION_ID, BASE_URL, CLAUDE_IDENTITY as CLAUDE_CODE_IDENTITY,
 claudeModel as model, context, sse,
 claudeStart as start, claudeTextResponse as textResponse, capture, object, array,
} from "./fixtures.ts";

// Tests exercise the real native SDK path with injected fetch, not just constants.
test("native transport sends minimal compatibility headers and preserves native request assembly", { timeout: 10_000 }, async () => {
	const mock = capture(textResponse);
	let payloadHook = 0;
	let responseHook = 0;
	let streamEvents = 0;
	const stream = claudeCodeStreamSimple(model(), context(), {
		apiKey: API_KEY, sessionId: SESSION_ID, reasoning: "max", maxTokens: 128_000,
		fetch: mock.fetch,
		headers: { Authorization: "Bearer synthetic-unwanted-token", "User-Agent": "Pi fixture", "x-test-extra": "kept" },
		onPayload: (payload) => { payloadHook++; assert.equal(object(payload).model, "claude-opus-5-5"); },
		onResponse: (response) => { responseHook++; assert.equal(response.status, 200); },
		onProviderStreamEvent: () => { streamEvents++; },
	});
	const result = await stream.result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(result.content[0]?.type, "text");
	assert.equal(result.content[0]?.type === "text" && result.content[0].text, "ok");
	assert.equal(mock.requests.length, 1);
	const request = mock.requests[0];
	assert.equal(request.url, `${BASE_URL}/v1/messages?beta=true`); // The native SDK query is retained.
	assert.equal(request.redirect, "error");
	assert.equal(request.headers.get("user-agent"), "claude-cli/2.1.274 (external, cli)");
	assert.equal(request.headers.get("x-app"), "cli");
	assert.equal(request.headers.get("x-claude-code-session-id"), SESSION_ID);
	assert.equal(request.headers.get("x-test-extra"), "kept");
	assert.equal(request.headers.get("x-trace-id"), null);
	const beta = request.headers.get("anthropic-beta") ?? "";
	assert.match(beta, /(^|,)context-1m-2025-08-07(,|$)/);
	assert.doesNotMatch(beta, /claude-code-20250219|thinking-token-count|context-management|prompt-caching|mid-conversation|effort-2025|thinking-display|afk-mode/);
	assert.equal(request.headers.get("authorization"), null);
	assert.deepEqual(request.body.thinking, { type: "adaptive", display: "summarized" });
	assert.deepEqual(request.body.output_config, { effort: "max" });
	assert.equal("context_management" in request.body, false);
	assert.equal(request.body.max_tokens, 128_000);
	assert.equal(request.body.stream, true);
	assert.equal("betas" in request.body, false); // SDK serializes betas as an HTTP header.
	const system = array(request.body.system).map(object);
	assert.equal(system.length, 2);
	assert.equal(system[0].text, CLAUDE_CODE_IDENTITY);
	assert.deepEqual(system[0].cache_control, { type: "ephemeral" });
	assert.deepEqual(system[1].cache_control, { type: "ephemeral" });
	assert.ok(String(system[1].text).includes("# Runtime instructions"));
	assert.ok(!String(system[1].text).includes("Keep project rules."));
	assert.ok(!JSON.stringify(system).includes("x-anthropic-billing-header"));
	const messages = array(request.body.messages).map(object);
	assert.equal(messages.length, 3);
	assert.equal(messages[0].role, "system");
	assert.equal(object(array(messages[0].content)[0]).text, "You are a coding assistant running inside pi, a coding agent harness. Keep project rules.");
	assert.equal(messages[1].role, "user");
	assert.equal(messages[2].role, "system");
	assert.ok(messages.every((message) => message.output_config === undefined));
	assert.equal(object(array(messages[2].content)[0]).text, "# Environment\nActual Pi context, not copied from the capture.");
	const metadata = object(JSON.parse(String(object(request.body.metadata).user_id)));
	assert.equal(metadata.session_id, request.headers.get("x-claude-code-session-id"));
	assert.match(String(metadata.device_id), /^[a-f0-9]{64}$/);
	assert.equal(object(array(request.body.tools)[0]).name, "Read");
	assert.equal(result.usage.input, 12);
	assert.equal(result.usage.output, 2);
	assert.equal(result.usage.cacheRead, 4);
	assert.equal(result.usage.cacheWrite, 2);
	assert.equal(result.usage.totalTokens, 20);
	assert.equal(payloadHook, 1);
	assert.equal(responseHook, 1);
	assert.equal(streamEvents, 6);
});

test("native SDK tool SSE is restored in both events and result()", { timeout: 10_000 }, async () => {
	const mock = capture(() => sse([
		start(),
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fixture", name: "Read", input: {} } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"fixture.txt"}' } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
		{ type: "message_stop" },
	]));
	const stream = claudeCodeStreamSimple(model(), context(), {
		apiKey: API_KEY, sessionId: SESSION_ID, reasoning: "low", fetch: mock.fetch,
	});
	const kinds: string[] = [];
	for await (const event of stream) {
		kinds.push(event.type);
		if ("partial" in event) {
			for (const block of event.partial.content) {
				if (block.type === "toolCall") assert.equal(block.name, "read");
			}
		}
		if (event.type === "done") {
			assert.equal(event.message.content[0]?.type === "toolCall" && event.message.content[0].name, "read");
		}
		if (event.type === "toolcall_end") {
			assert.equal(event.toolCall.name, "read");
			assert.deepEqual(event.toolCall.arguments, { path: "fixture.txt" });
		}
	}
	const result = await stream.result();
	assert.equal(result.stopReason, "toolUse", result.errorMessage);
	assert.equal(result.content[0]?.type === "toolCall" && result.content[0].name, "read");
	assert.equal(kinds[0], "start");
	assert.equal(kinds[kinds.length - 1], "done");
	assert.equal(kinds.filter((kind) => kind === "done").length, 1);
	assert.equal(object(mock.requests[0].body.output_config).effort, "low");
	const next = capture(textResponse);
	const nextResult = await claudeCodeStreamSimple(model(), normalizeContext({
		messages: [
			...context().messages, result,
			{ role: "toolResult", toolCallId: "toolu_fixture", toolName: "read", content: [{ type: "text", text: "fixture data" }], isError: false, timestamp: 3 },
		],
	}), { apiKey: API_KEY, reasoning: "low", fetch: next.fetch }).result();
	assert.equal(nextResult.stopReason, "stop", nextResult.errorMessage);
	const history = array(next.requests[0].body.messages).map(object).flatMap((message) => Array.isArray(message.content) ? message.content.map(object) : []);
	assert.equal(history.find((block) => block.type === "tool_use")?.id, "toolu_fixture");
	assert.equal(history.find((block) => block.type === "tool_use")?.name, "Read");
	assert.equal(history.find((block) => block.type === "tool_result")?.tool_use_id, "toolu_fixture");
});

test("thinking display updates preserve SSE thinking and signatures", { timeout: 10_000 }, async () => {
	const mock = capture(() => sse([
		start(),
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "A short update." } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-signature" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
		{ type: "message_stop" },
	]));
	const result = await claudeCodeStreamSimple(model(), context(), {
		apiKey: API_KEY, reasoning: "high", fetch: mock.fetch,
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.deepEqual(result.content[0], { type: "thinking", thinking: "A short update.", thinkingSignature: "fixture-signature" });
	assert.equal(object(mock.requests[0].body.thinking).display, "summarized");
});

test("native setup and HTTP failures terminate rather than losing result()", { timeout: 10_000 }, async () => {
	const mock = capture(() => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Fixture overload" } }), {
		status: 503, headers: { "content-type": "application/json" },
	}));
	const stream = claudeCodeStreamSimple(model(), context(), { apiKey: API_KEY, fetch: mock.fetch });
	const result = await stream.result();
	assert.equal(result.stopReason, "error");
	assert.ok(result.errorMessage?.includes("Fixture overload"));
	assert.equal(mock.requests.length, 1); // No automatic paid-request retry loop.
	const controller = new AbortController();
	controller.abort();
	const aborted = await claudeCodeStreamSimple(model(), context(), {
		apiKey: API_KEY, signal: controller.signal, fetch: mock.fetch,
	}).result();
	assert.equal(aborted.stopReason, "aborted");
	assert.equal(mock.requests.length, 1);
	assert.throws(() => claudeCodeStreamSimple(model(), context()), /No API key/);
});

test("adaptive-off and caller output caps are not forced to captured max values", { timeout: 10_000 }, async () => {
	const mock = capture(textResponse);
	await claudeCodeStreamSimple(model("claude-opus-4-6"), context(), {
		apiKey: API_KEY, maxTokens: 64, fetch: mock.fetch,
	}).result();
	assert.equal(mock.requests[0].body.max_tokens, 64);
	assert.deepEqual(mock.requests[0].body.thinking, { type: "disabled" });
	assert.equal("output_config" in mock.requests[0].body, false);
});

test("anonymous calls receive independent session IDs without adding trace headers", async () => {
	const mock = capture(textResponse);
	for (let i = 0; i < 2; i++) {
		const result = await claudeCodeStreamSimple(model(), context(), { apiKey: API_KEY, fetch: mock.fetch }).result();
		assert.equal(result.stopReason, "stop");
	}
	const [first, second] = mock.requests;
	const firstSession = first.headers.get("x-claude-code-session-id");
	const secondSession = second.headers.get("x-claude-code-session-id");
	assert.match(firstSession ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	assert.match(secondSession ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	assert.notEqual(firstSession, secondSession);
	assert.equal(first.headers.get("x-trace-id"), null);
	assert.equal(second.headers.get("x-trace-id"), null);
	const firstMetadata = object(JSON.parse(String(object(first.body.metadata).user_id)));
	const secondMetadata = object(JSON.parse(String(object(second.body.metadata).user_id)));
	assert.equal(firstMetadata.session_id, firstSession);
	assert.equal(secondMetadata.session_id, secondSession);
});
test("hook metadata cannot override Claude identity but preserves unrelated metadata", async () => {
	const mock = capture(textResponse);
	const result = await claudeCodeStreamSimple(model(), context(), {
		apiKey: API_KEY, sessionId: SESSION_ID, fetch: mock.fetch,
		onPayload: (payload) => ({
			...object(payload),
			metadata: { trace_id: "kept", user_id: JSON.stringify({ session_id: "hook", device_id: "hook", account_uuid: "hook", extra: "keep" }) },
		}),
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	const request = mock.requests[0];
	const metadata = object(request.body.metadata);
	assert.equal(metadata.trace_id, "kept");
	const userId = object(JSON.parse(String(metadata.user_id)));
	assert.equal(userId.session_id, SESSION_ID);
	assert.match(String(userId.device_id), /^[a-f0-9]{64}$/);
	assert.equal(userId.account_uuid, "");
	assert.equal(userId.extra, "keep");
});

test("malformed Claude metadata is rejected before fetch", async () => {
	const mock = capture(textResponse);
	const stream = claudeCodeStreamSimple(model(), context(), {
		apiKey: API_KEY, fetch: mock.fetch,
		onPayload: (payload) => ({ ...object(payload), metadata: "unsafe" }),
	});
	const result = await stream.result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /metadata/i);
	assert.equal(mock.requests.length, 0);
});


test("malformed Claude metadata.user_id is rejected clearly before fetch", async () => {
	const mock = capture(textResponse);
	const result = await claudeCodeStreamSimple(model(), context(), {
		apiKey: API_KEY, fetch: mock.fetch,
		onPayload: (payload) => ({ ...object(payload), metadata: { user_id: "not-json" } }),
	}).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /metadata\.user_id cannot be safely normalized/);
	assert.equal(mock.requests.length, 0);
});

for (const [label, run] of [
	["simple", claudeCodeStreamSimple],
	["raw", claudeCodeStream],
] as const) {
	test(`final fetch protects native Beta selection on ${label} streams`, { timeout: 10_000 }, async () => {
		const mock = capture(textResponse);
		const result = await run({
			...model(), headers: { "ANTHROPIC-BETA": "model-alias" },
		}, context(), {
			apiKey: API_KEY,
			// Case variants and null are caller input, not a Beta policy.
			headers: { "aNtHrOpIc-BeTa": "caller-alias", "x-test-extra": "kept" },
			fetch: mock.fetch,
			onPayload: (payload: unknown) => ({ ...object(payload), betas: ["hook-alias", "context-1m-2025-08-07"] }),
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		const beta = mock.requests[0].headers.get("anthropic-beta") ?? "";
		assert.match(beta, /(^|,)context-1m-2025-08-07(,|$)/);
		assert.doesNotMatch(beta, /caller-alias|hook-alias/);
		assert.equal(mock.requests[0].headers.get("x-test-extra"), "kept");
	});
}

test("native Beta order is retained before the missing context default", { timeout: 10_000 }, async () => {
	const mock = capture(textResponse);
	const options = { apiKey: API_KEY, fetch: mock.fetch };
	const result = await claudeCodeStream({ ...model(), compat: { ...model().compat, forceAdaptiveThinking: false } }, context(), options).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	const beta = mock.requests[0].headers.get("anthropic-beta") ?? "";
	assert.match(beta, /^fine-grained-tool-streaming-2025-05-14,context-1m-2025-08-07$/);
});

test("reasoning keeps native interleaved-thinking Beta and appends context default at final fetch", { timeout: 10_000 }, async () => {
	const mock = capture(textResponse);
	const eligibleModel = { ...model(), compat: { ...model().compat, forceAdaptiveThinking: false } };
	const options = { apiKey: API_KEY, thinkingEnabled: true, effort: "high", fetch: mock.fetch };
	const result = await claudeCodeStream(eligibleModel, context(), options).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	const beta = mock.requests[0].headers.get("anthropic-beta") ?? "";
	assert.equal(beta, "fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14,context-1m-2025-08-07");
});

test("a relay key with OAuth-like text still uses x-api-key only", { timeout: 10_000 }, async () => {
	const mock = capture(textResponse);
	const relayKey = "offline-sk-ant-oat-fixture-not-a-token";
	const result = await claudeCodeStreamSimple(model(), context(), {
		apiKey: relayKey, reasoning: "low", fetch: mock.fetch,
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(mock.requests[0].headers.get("x-api-key"), relayKey);
	assert.equal(mock.requests[0].headers.get("authorization"), null);
	assert.match(mock.requests[0].headers.get("anthropic-beta") ?? "", /(^|,)context-1m-2025-08-07(,|$)/);
	assert.doesNotMatch(mock.requests[0].headers.get("anthropic-beta") ?? "", /claude-code-20250219/);
});
