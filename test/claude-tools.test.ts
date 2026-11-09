import assert from "node:assert/strict";
import { test } from "node:test";
import { wireToolNamesDeep } from "../src/claude/tools.ts";
import { Type } from "typebox";
import { normalizeContext } from "@earendil-works/pi-ai";
import { claudeCodeStream, claudeCodeStreamSimple } from "../src/claude/stream.ts";
import { API_KEY, claudeModel, claudeStart, claudeTextResponse, capture, object, array, sse } from "./fixtures.ts";

test("different real identities with a case-insensitive wire collision fail before final fetch", { timeout: 10_000 }, async () => {
	for (const streamClaude of [claudeCodeStream, claudeCodeStreamSimple]) {
		for (const names of [["read", "Read"], ["Read", "read"], ["todo_write", "TodoWrite"]]) {
			const mock = capture(claudeTextResponse);
			const stream = streamClaude(claudeModel(), normalizeContext({
				tools: names.map((name) => ({ name, description: name, parameters: Type.Object({}) })),
				messages: [{ role: "user", content: "Use a real tool", timestamp: 1 }],
			}), { apiKey: API_KEY, fetch: mock.fetch });
			const kinds: string[] = [];
			for await (const event of stream) kinds.push(event.type);
			const result = await stream.result();
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage ?? "", /tool.*collision/i);
			assert.equal(mock.requests.length, 0);
			assert.equal(kinds.at(-1), "error");
		}
	}
});
test("removed and unknown response tools are not substituted or re-declared on replay", { timeout: 10_000 }, async () => {
	for (const returnedName of ["Read", "Glob"]) {
		const mock = capture(() => sse([
			claudeStart(),
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_old", name: returnedName, input: {} } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		]));
		const tools = [{ name: "bash", description: "Real available tool", parameters: Type.Object({}) }];
		const history = [
			{ role: "user" as const, content: "Use a tool", timestamp: 1 },
			{ role: "assistant" as const, api: "anthropic-messages" as const, provider: "chameleon-claude", model: "claude-opus-5-5",
				content: [{ type: "toolCall" as const, id: "call_previous", name: "read", arguments: { path: "file" } }],
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" as const, timestamp: 2 },
			{ role: "toolResult" as const, toolCallId: "call_previous", toolName: "read",
				content: [{ type: "text" as const, text: "previous result" }], isError: false, timestamp: 3 },
		];
		const result = await claudeCodeStreamSimple(claudeModel(), normalizeContext({ tools, messages: history }),
			{ apiKey: API_KEY, fetch: mock.fetch }).result();
		assert.equal(result.stopReason, "toolUse", result.errorMessage);
		assert.equal(result.content[0]?.type === "toolCall" && result.content[0].name, returnedName === "Read" ? "read" : "Glob");
		assert.equal(mock.requests.length, 1);
		assert.deepEqual(array(mock.requests[0].body.tools).map((tool) => object(tool).name), ["Bash"]);
		const replay = capture(claudeTextResponse);
		const next = await claudeCodeStreamSimple(claudeModel(), normalizeContext({ tools, messages: [
			...history, result,
			{ role: "toolResult", toolCallId: "call_old", toolName: returnedName === "Read" ? "read" : "Glob",
				content: [{ type: "text", text: "Tool unavailable" }], isError: true, timestamp: 4 },
		] }), { apiKey: API_KEY, fetch: replay.fetch }).result();
		assert.equal(next.stopReason, "stop", next.errorMessage);
		assert.equal(replay.requests.length, 1);
		assert.deepEqual(array(replay.requests[0].body.tools).map((tool) => object(tool).name), ["Bash"]);
		const blocks = array(replay.requests[0].body.messages).map(object).flatMap((message) => Array.isArray(message.content) ? message.content.map(object) : []);
		assert.equal(blocks.find((block) => block.type === "tool_use" && block.id === "call_old")?.name, returnedName);
		assert.equal(blocks.find((block) => block.type === "tool_result" && block.tool_use_id === "call_old")?.is_error, true);
	}
});

// Claude-only internal seam: no generic mapper or Codex no-op adapter.
// Stream event/result restoration is covered by the real SDK transport tests.
test("collision detection spans choices, history and later definitions/references, but repeated identity is legal", () => {
	const references = [
		{ tool_choice: { type: "tool", name: "Read" } },
		{ messages: [{ role: "assistant", content: [{ type: "tool_use", id: "past", name: "Read", input: {} }] }] },
		{ system: [{ type: "text", text: "changes", blocks: [{ type: "tool_reference", name: "Read" }] }] },
		{ messages: [{ role: "system", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "Read", input_schema: {} } } }] }] },
	];
	for (const reference of references) {
		assert.throws(() => wireToolNamesDeep({ tools: [{ name: "read", input_schema: {} }], ...reference }, new Map()), /tool.*collision/i);
	}
	assert.throws(() => wireToolNamesDeep({
		tool_choice: { type: "tool", name: "read" },
		messages: [{ role: "system", content: [{ type: "tool_reference", name: "Read" }] }],
	}, new Map()), /tool.*collision/i);
	const names = new Map<string, string>();
	wireToolNamesDeep({ tools: [{ name: "read", input_schema: {} }], tool_choice: { type: "tool", name: "read" },
		messages: [{ role: "assistant", content: [1, 2].map((id) => ({ type: "tool_use", id: String(id), name: "read", input: {} })) }],
	}, names);
	assert.deepEqual([...names], [["read", "read"]]);
});
test("protocol lookalikes inside nested results and unknown data neither rewrite nor collide", () => {
	const lookalike = { type: "tool_use", name: "Read", input_schema: {}, content: [{ type: "tool_reference", name: "read" }] };
	const source = {
		tools: [{ name: "read", input_schema: { examples: [lookalike] } }],
		metadata: { tools: [{ name: "Read", input_schema: {} }] },
		messages: [
			{ role: "assistant", content: [{ type: "tool_use", id: "actual", name: "read", input: { content: [lookalike] } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "actual", content: [lookalike] }] },
		],
	};
	const before = structuredClone(source);
	const names = new Map<string, string>();
	const body = object(wireToolNamesDeep(source, names));
	assert.deepEqual(source, before);
	assert.deepEqual(body.metadata, source.metadata);
	assert.deepEqual(object(array(body.tools)[0]).input_schema, source.tools[0].input_schema);
	const history = array(body.messages).map(object);
	assert.deepEqual(object(array(history[0].content)[0]).input, object(source.messages[0].content[0]).input);
	assert.deepEqual(history[1], source.messages[1]);
	assert.deepEqual([...names], [["read", "read"]]);
});
test("Claude tool mapping covers definitions, history, choice and mid-turn references", () => {
	const names = new Map<string, string>();
	const body = object(wireToolNamesDeep({
		tools: ["read", "todo_write", "kill_shell", "mycustom"].map((name) => ({ name, input_schema: {} })),
		tool_choice: { type: "tool", name: "read" },
		messages: [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_fixture", name: "read", input: {} }] }],
		system: [{ type: "text", text: "real tool changes", blocks: [
			{ type: "tool_removal", tool: { type: "tool_reference", name: "read" } },
			{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "bash", input_schema: {} } } },
		] }],
	}, names));
	assert.deepEqual(array(body.tools).map((entry) => object(entry).name), ["Read", "TodoWrite", "KillShell", "Mycustom"]);
	assert.equal(object(body.tool_choice).name, "Read");
	assert.equal(object(array(object(array(body.messages)[0]).content)[0]).name, "Read");
	const blocks = array(object(array(body.system)[0]).blocks).map(object);
	assert.equal(object(blocks[0].tool).name, "Read");
	assert.equal(object(object(blocks[1].tool).definition).name, "Bash");
	assert.equal(names.get("read"), "read");
	assert.equal(names.get("todowrite"), "todo_write");
});

test("tool schemas, arguments and tool-result/user data remain opaque", () => {
	const data = { type: "tool_use", name: "must-not-change", input_schema: {} };
	const schema = { type: "object", $defs: { example: data } };
	const body = object(wireToolNamesDeep({
		tools: [{ name: "read", input_schema: schema }],
		messages: [
			{ role: "assistant", content: [{ type: "tool_use", name: "read", input: data }] },
			{ role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: JSON.stringify(data) }] }] },
		],
	}, new Map()));
	assert.deepEqual(object(array(body.tools)[0]).input_schema, schema);
	const messages = array(body.messages).map(object);
	assert.deepEqual(object(array(messages[0].content)[0]).input, data);
	assert.equal(object(array(object(array(messages[1].content)[0]).content)[0]).text, JSON.stringify(data));
});
