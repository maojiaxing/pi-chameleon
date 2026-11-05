import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { normalizeContext } from "@earendil-works/pi-ai";
import { codexStreamSimple } from "../src/codex/stream.ts";
import {
 API_KEY, SESSION_ID, CODEX_IDENTITY, BASE_URL as RELAY_URL, codexModel as model,
 context, sse, codexTextResponse as textResponse, capture, object, array,
} from "./fixtures.ts";
const BASE_URL = `${RELAY_URL}/v1`;

test("native transport sends the official 0.166.0 headers and Responses body", { timeout: 10_000 }, async () => {
	const mock = capture(textResponse);
	let payloadHook = 0;
	let responseHook = 0;
	let streamEvents = 0;
	const stream = codexStreamSimple(model(), context(), {
		apiKey: API_KEY,
		sessionId: SESSION_ID,
		reasoning: "high",
		fetch: mock.fetch,
		headers: {
			Authorization: "Bearer synthetic-unwanted-token",
			"User-Agent": "Pi fixture",
			"x-stainless-os": "Linux",
			"x-test-extra": "kept",
		},
		onPayload: (payload) => {
			payloadHook++;
			assert.equal(object(payload).model, "gpt-5.3-codex");
		},
		onResponse: (response) => {
			responseHook++;
			assert.equal(response.status, 200);
		},
		onProviderStreamEvent: () => {
			streamEvents++;
		},
	});
	const result = await stream.result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(result.content[0]?.type, "text");
	assert.equal(result.content[0]?.type === "text" && result.content[0].text, "ok");
	assert.equal(mock.requests.length, 1);
	const request = mock.requests[0];
	assert.equal(request.url, `${BASE_URL}/responses`);
	assert.equal(request.redirect, "error");
	assert.equal(request.headers.get("authorization"), `Bearer ${API_KEY}`);
	assert.equal(request.headers.get("originator"), "codex_cli_rs");
	assert.equal(request.headers.get("version"), "0.166.0");
	assert.equal(request.headers.get("session-id"), SESSION_ID);
	assert.equal(request.headers.get("accept"), "text/event-stream");
	assert.equal(request.headers.get("content-type"), "application/json");
	assert.match(request.headers.get("user-agent") ?? "", /^codex_cli_rs\/0\.166\.0 \(.+; [a-z0-9_]+\) .+$/);
	// Rust client fingerprint: no Stainless headers from the TS SDK.
	assert.equal(request.headers.get("x-stainless-os"), null);
	assert.equal(request.headers.get("thread-id"), SESSION_ID);
	assert.equal(request.headers.get("x-client-request-id"), SESSION_ID);
	assert.equal(request.headers.get("x-test-extra"), "kept");
	// Body: official ResponsesApiRequest field set and order.
	assert.deepEqual(Object.keys(request.body), [
		"model",
		"stream",
		"input",
		"tools",
		"tool_choice",
		"parallel_tool_calls",
		"reasoning",
		"store",
		"include",
		"prompt_cache_key",
	]);
	assert.equal(request.body.model, "gpt-5.3-codex");
	assert.equal(request.body.stream, true);
	assert.equal(request.body.store, false);
	assert.equal(request.body.tool_choice, "auto");
	assert.equal(request.body.parallel_tool_calls, true);
	assert.deepEqual(object(request.body.reasoning), { effort: "high", summary: "auto" });
	assert.deepEqual(request.body.include, ["reasoning.encrypted_content"]);
	assert.equal(request.body.prompt_cache_key, SESSION_ID);
	assert.equal("temperature" in request.body, false);
	assert.equal("max_output_tokens" in request.body, false);
	assert.equal("instructions" in request.body, false);
	// Input: Codex identity and real Pi rules in the leading developer item.
	const input = array(request.body.input).map(object);
	assert.equal(input[0].role, "developer");
	assert.equal(input[0].content, `${CODEX_IDENTITY}\n\nKeep project rules.`);
	assert.equal(input[1].role, "user");
	assert.equal(input[input.length - 1].role, "developer");
	assert.ok(String(input[input.length - 1].content).includes("# Environment"));
	const tools = array(request.body.tools).map(object);
	assert.equal(tools.length, 1);
	assert.equal(tools[0].type, "function");
	assert.equal(tools[0].name, "read");
	assert.deepEqual(object(object(tools[0].parameters).properties).path, { type: "string" });
	// Usage comes from response.completed.
	assert.equal(result.usage.input, 8);
	assert.equal(result.usage.output, 2);
	assert.equal(result.usage.cacheRead, 4);
	assert.equal(result.usage.totalTokens, 14);
	assert.equal(payloadHook, 1);
	assert.equal(responseHook, 1);
	assert.equal(streamEvents, 5);
});

test("native tool SSE round-trips without name mapping", { timeout: 10_000 }, async () => {
	const mock = capture(() => sse([
		{ type: "response.created", response: { id: "resp_fixture" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "read", arguments: "" },
		},
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"fixture.txt"}' },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "read", arguments: '{"path":"fixture.txt"}' },
		},
		{
			type: "response.completed",
			response: { id: "resp_fixture", status: "completed", usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }, output: [] },
		},
	]));
	const stream = codexStreamSimple(model(), context(), {
		apiKey: API_KEY,
		sessionId: SESSION_ID,
		reasoning: "low",
		fetch: mock.fetch,
	});
	const result = await stream.result();
	assert.equal(result.stopReason, "toolUse", result.errorMessage);
	const call = result.content.find((block) => block.type === "toolCall");
	assert.ok(call?.type === "toolCall");
	assert.equal(call.name, "read");
	assert.equal(call.id, "call_fixture|fc_fixture");
	assert.deepEqual(call.arguments, { path: "fixture.txt" });
	const request = mock.requests[0];
	assert.equal(object(array(request.body.tools)[0]).name, "read");
	assert.deepEqual(object(request.body.reasoning), { effort: "low", summary: "auto" });
	const next = capture(textResponse);
	const followup = normalizeContext({
		tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
		messages: [
			...context().messages, result,
			{ role: "toolResult", toolCallId: call.id, toolName: "read", content: [{ type: "text", text: "fixture content" }], isError: false, timestamp: 3 },
		],
	});
	const nextResult = await codexStreamSimple(model(), followup, { apiKey: API_KEY, fetch: next.fetch }).result();
	assert.equal(nextResult.stopReason, "stop", nextResult.errorMessage);
	const history = array(next.requests[0].body.input).map(object);
	const wireCall = history.find((item) => item.type === "function_call");
	const wireResult = history.find((item) => item.type === "function_call_output");
	assert.equal(wireCall?.call_id, "call_fixture");
	assert.equal(wireCall?.id, "fc_fixture");
	assert.equal(wireResult?.call_id, wireCall?.call_id);
});
