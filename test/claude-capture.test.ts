import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Type } from "typebox";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { claudeCodeStreamSimple } from "../src/claude/stream.ts";
import { claudePayloadAdapter } from "../src/claude/payload.ts";
import {
	API_KEY, SESSION_ID, CLAUDE_IDENTITY, claudeModel, claudeTextResponse,
	capture, context, object, array, sse, claudeStart,
} from "./fixtures.ts";

const runtime = "You are an expert coding assistant operating inside pi, a coding agent harness.\n\n<tools>read</tools>\n<rules>Only read approved files.</rules>\n<cwd>/actual/project</cwd>";
const CACHE = { type: "ephemeral" };
function cacheLocations(body: Record<string, unknown>): string[] {
	const locations: string[] = [];
	for (const [i, block] of array(body.system ?? []).entries()) if (object(block).cache_control) locations.push(`system:${i}`);
	for (const [i, tool] of array(body.tools ?? []).entries()) if (object(tool).cache_control) locations.push(`tools:${i}`);
	for (const [i, message] of array(body.messages ?? []).entries()) {
		if (Array.isArray(object(message).content)) {
			for (const [j, block] of array(object(message).content).entries()) {
				if (object(block).cache_control) locations.push(`message:${i}:${j}`);
			}
		}
	}
	return locations;
}

test("real-capture layout keeps two system blocks and original Pi instructions in the first system message", async () => {
	const mock = capture(claudeTextResponse);
	const result = await claudeCodeStreamSimple(claudeModel(), normalizeContext({
		systemPrompt: runtime,
		tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }), constrainedSampling: { type: "json_schema", strict: "prefer" } }],
		messages: [{ role: "user", content: "5+5", timestamp: 1 }],
	}), { apiKey: API_KEY, sessionId: SESSION_ID, reasoning: "low", maxTokens: 128_000, fetch: mock.fetch }).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	const body = mock.requests[0].body;
	const system = array(body.system).map(object);
	assert.equal(system.length, 2);
	assert.equal(system[0].text, CLAUDE_IDENTITY);
	assert.ok(String(system[1].text).includes("# Runtime instructions"));
	assert.ok(!String(system[1].text).includes(runtime));
	assert.ok(!JSON.stringify(system).includes("x-anthropic-billing-header"));
	assert.ok(!JSON.stringify(system).includes("<total_tokens>"));
	const messages = array(body.messages).map(object);
	assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
	assert.equal(object(array(messages[0].content)[0]).text, runtime);
	assert.equal(object(array(messages[1].content)[0]).text, "5+5");
	assert.ok(messages.every((message) => message.output_config === undefined));
	assert.ok(!JSON.stringify(messages).includes("[System Instructions]"));
	const tools = array(body.tools).map(object);
	assert.deepEqual(tools.map((tool) => tool.name), ["Read"]);
	assert.equal(tools[0].strict, undefined);
	assert.equal(tools[0].eager_input_streaming, undefined);
	assert.equal(tools[0].defer_loading, undefined);
	assert.deepEqual(object(tools[0].input_schema).required, ["path"]);
	assert.deepEqual(object(object(tools[0].input_schema).properties).offset, { type: "number" });
	assert.deepEqual(cacheLocations(body), ["system:0", "system:1", "tools:0", "message:1:0"]);
	assert.deepEqual(body.output_config, { effort: "low" });
	assert.equal(body.max_tokens, 128_000);
});

test("message-system migration is idempotent and keeps later system turns and source text", async () => {
	const source = {
		system: [{ type: "text", text: runtime, cache_control: CACHE }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "first", cache_control: CACHE }] },
			{ role: "assistant", content: [{ type: "text", text: "previous answer" }] },
			{ role: "system", content: [{ type: "text", text: "real later update", cache_control: CACHE }] },
			{ role: "user", content: [{ type: "text", text: "next", cache_control: CACHE }] },
		],
	};
	const before = structuredClone(source);
	const adapter = claudePayloadAdapter(SESSION_ID);
	const prepared = adapter.prepare(source, claudeModel(), false);
	const once = object(prepared.finish(prepared.value));
	const repeated = adapter.prepare(once, claudeModel(), false);
	const twice = object(repeated.finish(repeated.value));
	assert.deepEqual(twice, once);
	assert.deepEqual(source, before);
	const messages = array(once.messages).map(object);
	assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "system", "user"]);
	assert.equal(object(array(messages[0].content)[0]).text, runtime);
	assert.equal(object(array(messages[3].content)[0]).text, "real later update");
	assert.deepEqual(cacheLocations(once), ["system:0", "system:1", "message:4:0"]);
});

test("native later tool additions and removals use the current top-level tool set without deferred placeholders", async () => {
	const mock = capture(claudeTextResponse);
	const readTool = { name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) };
	const grepTool = { name: "grep", description: "Search", parameters: Type.Object({ pattern: Type.String() }) };
	const result = await claudeCodeStreamSimple(claudeModel(), normalizeContext({
		messages: [
			{ role: "system", content: [{ type: "text", text: runtime }], toolsAdded: [readTool], timestamp: 0 },
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "system", content: [{ type: "text", text: "Search instead of reading." }], toolsAdded: [grepTool], toolsRemoved: [{ name: "read" }], timestamp: 2 },
			{ role: "user", content: "Find a symbol", timestamp: 3 },
		],
	}), { apiKey: API_KEY, reasoning: "medium", fetch: mock.fetch }).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	const body = mock.requests[0].body;
	assert.deepEqual(array(body.tools).map((tool) => object(tool).name), ["Grep"]);
	assert.ok(!JSON.stringify(body).includes("__pi_deferred_placeholder__"));
	assert.ok(!JSON.stringify(body.messages).includes('"type":"tool_addition"'));
	assert.ok(!JSON.stringify(body.messages).includes('"effort"'));
	assert.ok(JSON.stringify(body.messages).includes("Search instead of reading."));
});

test("capture schema policy never silently downgrades a tool that requires strict validation", async () => {
	const mock = capture(claudeTextResponse);
	const result = await claudeCodeStreamSimple(claudeModel(), normalizeContext({
		tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }), constrainedSampling: { type: "json_schema", strict: "require" } }],
		messages: [{ role: "user", content: "Read", timestamp: 1 }],
	}), { apiKey: API_KEY, fetch: mock.fetch }).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /requires.*strict tools are unsupported/);
	assert.equal(mock.requests.length, 0);
});

test("capture cache placement preserves schema/input data and runs after caller hooks", async () => {
	const opaque = { type: "tool_use", name: "leave-me", cache_control: { type: "example" } };
	const source = {
		system: runtime,
		tools: ["read", "write"].map((name) => ({ name, input_schema: { type: "object", $defs: { opaque } }, cache_control: CACHE })),
		messages: [
			{ role: "user", content: [{ type: "text", text: "task", cache_control: CACHE }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "toolu_fixture", name: "read", input: opaque }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fixture", content: "data", cache_control: CACHE }] },
		],
	};
	const before = structuredClone(source);
	const hook = (value: unknown) => {
		const body = object(value);
		return { ...body, messages: [...array(body.messages), ...[1, 2, 3, 4, 5].map((i) => ({
			role: "user", content: [{ type: "text", text: `hook-${i}`, cache_control: CACHE }],
		}))] };
	};
	const prepared = claudePayloadAdapter(SESSION_ID).prepare(source, claudeModel(), true);
	const body = object(prepared.finish(hook(prepared.value)));
	const slots = cacheLocations(body);
	assert.equal(slots.length, 4);
	assert.deepEqual(slots.slice(0, 3), ["system:0", "system:1", "tools:1"]);
	const messages = array(body.messages).map(object);
	assert.equal(object(array(messages[messages.length - 1].content)[0]).text, "hook-5");
	assert.deepEqual(object(object(object(array(body.tools)[0]).input_schema).$defs).opaque, opaque);
	const call = messages.flatMap((message) => Array.isArray(message.content) ? array(message.content).map(object) : []).find((block) => block.type === "tool_use");
	assert.deepEqual(call?.input, opaque);
	assert.deepEqual(source, before);
});

test("three continuous turns carry actual prior replies once with stable identity and cache layout", async () => {
	const transcript = normalizeContext({
		systemPrompt: runtime,
		tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
		messages: [],
	});
	const mock = capture(claudeTextResponse);
	const questions = ["我需要你计算1+1", "2+2呢？", "5+5"];
	for (const [i, question] of questions.entries()) {
		transcript.messages.push({ role: "user", content: question, timestamp: i * 2 + 1 });
		const result = await claudeCodeStreamSimple(claudeModel(), transcript, {
			apiKey: API_KEY, sessionId: SESSION_ID, reasoning: "low", maxTokens: 128_000, fetch: mock.fetch,
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		const body = mock.requests[i].body;
		const messages = array(body.messages).map(object);
		assert.deepEqual(messages.map((message) => message.role), ["system", ...questions.slice(0, i).flatMap(() => ["user", "assistant"]), "user"]);
		assert.equal(object(array(messages[0].content)[0]).text, runtime);
		const userTexts = messages.filter((message) => message.role === "user").map((message) =>
			typeof message.content === "string" ? message.content : String(object(array(message.content)[0]).text),
		);
		assert.deepEqual(userTexts, questions.slice(0, i + 1));
		const assistants = messages.filter((message) => message.role === "assistant");
		assert.equal(assistants.length, i);
		assert.ok(assistants.every((message) => object(array(message.content)[0]).text === "ok"));
		assert.deepEqual(cacheLocations(body), ["system:0", "system:1", "tools:0", `message:${messages.length - 1}:0`]);
		assert.equal(mock.requests[i].headers.get("x-claude-code-session-id"), SESSION_ID);
		assert.equal(JSON.parse(String(object(body.metadata).user_id)).session_id, SESSION_ID);
		assert.deepEqual(body.system, mock.requests[0].body.system);
		assert.deepEqual(body.tools, mock.requests[0].body.tools);
		transcript.messages.push(result);
	}
	assert.equal(mock.requests.length, 3);
});

test("production read-tool roundtrip retains exact file output, cache placement and caller limits", { timeout: 10_000 }, async () => {
	const project = fileURLToPath(new URL("../", import.meta.url));
	const path = "src/relay-transport.ts";
	const before = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
	const read = createReadTool(project);
	const transcript = normalizeContext({
		systemPrompt: runtime,
		tools: [read],
		messages: [{ role: "user", content: `读取并分析 ${path}`, timestamp: 1 }],
	});
	const first = capture(() => sse([
		claudeStart(),
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_actual_read", name: "Read", input: {} } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path, limit: 200 }) } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } },
		{ type: "message_stop" },
	]));
	const answer = await claudeCodeStreamSimple(claudeModel(), transcript, {
		apiKey: API_KEY, sessionId: SESSION_ID, reasoning: "low", maxTokens: 4096, fetch: first.fetch,
	}).result();
	assert.equal(answer.stopReason, "toolUse", answer.errorMessage);
	const call = answer.content.find((block) => block.type === "toolCall");
	assert.ok(call?.type === "toolCall");
	assert.equal(call.name, "read");
	assert.deepEqual(call.arguments, { path, limit: 200 });
	const toolResult = await read.execute(call.id, { path, limit: 200 });
	const fileText = toolResult.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	assert.ok(fileText.includes("prepareRelayRequest"));
	assert.ok(fileText.includes("redirect:"));
	transcript.messages.push(answer, {
		role: "toolResult", toolCallId: call.id, toolName: "read", content: toolResult.content,
		isError: false, timestamp: 2,
	});
	const next = capture(claudeTextResponse);
	const result = await claudeCodeStreamSimple(claudeModel(), transcript, {
		apiKey: API_KEY, sessionId: SESSION_ID, reasoning: "low", maxTokens: 4096, fetch: next.fetch,
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	const body = next.requests[0].body;
	const messages = array(body.messages).map(object);
	assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
	const wireCall = object(array(messages[2].content)[0]);
	const wireResult = object(array(messages[3].content)[0]);
	assert.equal(wireCall.id, call.id);
	assert.equal(wireCall.name, "Read");
	assert.equal(wireResult.tool_use_id, call.id);
	const returnedText = typeof wireResult.content === "string" ? wireResult.content
		: array(wireResult.content).map((part) => object(part).text).join("\n");
	assert.equal(returnedText, fileText);
	assert.deepEqual(cacheLocations(body), ["system:0", "system:1", "tools:0", "message:3:0"]);
	assert.equal(body.max_tokens, 4096);
	assert.deepEqual(body.output_config, { effort: "low" });
	assert.deepEqual(body.system, first.requests[0].body.system);
	assert.equal(next.requests[0].headers.get("x-claude-code-session-id"), first.requests[0].headers.get("x-claude-code-session-id"));
	assert.equal(await readFile(new URL(`../${path}`, import.meta.url), "utf8"), before);
});

test("HTTP 200 with a refusal stop remains an error, not a successful conversation turn", async () => {
	const explanation = "Cyber safeguards flagged this message.";
	const mock = capture(() => sse([
		claudeStart(),
		{ type: "message_delta", delta: { stop_reason: "refusal", stop_details: { explanation }, stop_sequence: null }, usage: { output_tokens: 0 } },
		{ type: "message_stop" },
	]));
	const statuses: number[] = [];
	const result = await claudeCodeStreamSimple(claudeModel(), context(), {
		apiKey: API_KEY, fetch: mock.fetch, onResponse: (response) => { statuses.push(response.status); },
	}).result();
	assert.deepEqual(statuses, [200]);
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, explanation);
	assert.equal(mock.requests.length, 1);
});

test("serialized instruction-only messages cannot shift the effective cache marker away from actual tool results", async () => {
	const adapter = claudePayloadAdapter(SESSION_ID);
	const prepared = adapter.prepare({
		system: runtime,
		messages: [
			{ role: "user", content: "read this file" },
			{ role: "assistant", content: [{ type: "tool_use", id: "toolu_fixture", name: "read", input: { path: "fixture.ts" } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fixture", content: "file output" }] },
			{ role: "system", content: [{ type: "text", text: "Keep later project rules." }], output_config: { effort: "high" } },
		],
	}, claudeModel(), false);
	const body = object(prepared.finish(prepared.value));
	const messages = array(body.messages).map(object);
	assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "user", "system"]);
	assert.equal(object(array(messages[3].content)[0]).tool_use_id, "toolu_fixture");
	assert.equal(object(array(messages[4].content)[0]).text, "Keep later project rules.");
	assert.deepEqual(messages[4].output_config, { effort: "high" });
	assert.deepEqual(cacheLocations(body), ["system:0", "system:1", "message:3:0"]);
	const repeated = adapter.prepare(body, claudeModel(), false);
	assert.deepEqual(repeated.finish(repeated.value), body);
});

test("caller cap and effort remain caller-selected instead of being forced to the sample values", async () => {
	const mock = capture(claudeTextResponse);
	await claudeCodeStreamSimple(claudeModel(), context(), { apiKey: API_KEY, maxTokens: 512, reasoning: "max", fetch: mock.fetch }).result();
	assert.equal(mock.requests[0].body.max_tokens, 512);
	assert.deepEqual(mock.requests[0].body.output_config, { effort: "max" });
	assert.ok(array(mock.requests[0].body.messages).map(object).every((message) => message.output_config === undefined));
});
