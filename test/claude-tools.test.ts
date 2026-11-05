import assert from "node:assert/strict";
import { test } from "node:test";
import { wireToolNamesDeep } from "../src/claude/tools.ts";
import { object, array } from "./fixtures.ts";

// Claude-only internal seam: no generic mapper or Codex no-op adapter.
// Stream event/result restoration is covered by the real SDK transport tests.
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
