import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { claudeCodeStreamSimple } from "../src/claude/stream.ts";
import { claudePayloadAdapter } from "../src/claude/payload.ts";
import { claudeCodePrompt } from "../src/claude/prompts.ts";
import {
	API_KEY, SESSION_ID, CLAUDE_IDENTITY, claudeModel, claudeTextResponse,
	capture, object, array,
} from "./fixtures.ts";

async function request(prompt?: string) {
	const mock = capture(claudeTextResponse);
	const result = await claudeCodeStreamSimple(claudeModel(), normalizeContext({
		systemPrompt: prompt, messages: [{ role: "user", content: "hello", timestamp: 1 }],
	}), { apiKey: API_KEY, reasoning: "high", sessionId: SESSION_ID, fetch: mock.fetch }).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	return mock.requests[0].body;
}

test("Claude prompt retains exact Pi text and its system role, without changing quoted identities", async () => {
	const prompt = "You are an expert coding assistant operating inside pi. Help users.\n\n<rules>Example: You are an expert coding assistant operating inside pi.</rules>\n<cwd>/actual/project</cwd>";
	const body = await request(prompt);
	const system = array(body.system).map(object);
	assert.equal(system.length, 2);
	assert.equal(system[0].text, CLAUDE_IDENTITY);
	assert.ok(String(system[1].text).includes("# Runtime instructions"));
	assert.ok(!String(system[1].text).includes(prompt));
	for (const block of system) assert.deepEqual(block.cache_control, { type: "ephemeral" });
	const messages = array(body.messages).map(object);
	assert.equal(messages[0].role, "system");
	assert.equal(object(array(messages[0].content)[0]).text, prompt);
	assert.equal(messages[0].output_config, undefined);
	assert.deepEqual(object(array(messages[1].content)[0]).cache_control, { type: "ephemeral" });
	assert.equal(body.context_management, undefined);
});

test("empty runtime uses the two fixed capture blocks without invented conversation or capabilities", async () => {
	const body = await request();
	const system = array(body.system).map(object);
	assert.equal(system.length, 2);
	assert.equal(system[0].text, CLAUDE_IDENTITY);
	const text = String(system[1].text);
	assert.ok(text.startsWith("You are an agent working with the user toward their goals, using your own judgment along the way."));
	for (const section of ["# Harness", "# Context management", "# Runtime instructions"]) assert.ok(text.includes(section));
	for (const omitted of ["# Memory", "# Environment", "<total_tokens>", "Available agent types", "Claude Agent SDK", "x-anthropic-billing-header"]) assert.ok(!text.includes(omitted));
	assert.deepEqual(array(body.messages).map((message) => object(message).role), ["user"]);
});

test("standalone legacy prefixes are removed but text blocks, blank space and quoted content survive", () => {
	const billing = "x-anthropic-billing-header: cc_version=2.1.220.e92; cc_entrypoint=sdk-cli;";
	const runtime = "Keep rules.  ";
	const quoted = `<project_context>Example: ${billing}</project_context>`;
	const source = { system: [
		{ type: "text", text: billing },
		{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
		{ type: "text", text: runtime },
		{ type: "text", text: "" },
		{ type: "text", text: quoted },
	], messages: [{ role: "user", content: "hello" }] };
	const before = structuredClone(source);
	const once = claudeCodePrompt(source);
	assert.equal(object(once.messages[0]).role, "system");
	assert.equal(object(array(object(once.messages[0]).content)[0]).text, `${runtime}\n\n\n\n${quoted}`);
	assert.deepEqual(claudeCodePrompt(once), once);
	assert.deepEqual(source, before);
	assert.throws(() => claudeCodePrompt({ system: { text: "invalid" } }), /string or text-block array/);
	assert.throws(() => claudeCodePrompt({ system: [{ type: "image", text: "invalid" }] }), /non-text block/);
	assert.throws(() => claudeCodePrompt({ messages: "invalid" }), /messages must be an array/);
});

test("old appended Runtime prefix unwraps into a single first system message", () => {
	const prefix = claudeCodePrompt({}).system[1].text;
	const runtime = `${CLAUDE_IDENTITY} Keep my actual runtime rules.\n\n<rules>Quoted # Runtime instructions remains data.</rules>`;
	const source = { system: [{ type: "text", text: CLAUDE_IDENTITY }, { type: "text", text: prefix + runtime }], messages: [{ role: "user", content: "analyze" }] };
	const once = claudeCodePrompt(source);
	assert.equal(object(once.messages[0]).role, "system");
	assert.equal(object(array(object(once.messages[0]).content)[0]).text, runtime);
	assert.deepEqual(claudeCodePrompt(once), once);
});

test("only this project's exact prior billing/ACK envelope is migrated, not arbitrary user history", () => {
	const current = claudeCodePrompt({});
	const core = current.system[1].text.split("\n# Runtime instructions\n")[0].trimEnd();
	const runtime = "Keep all Pi instructions.";
	const source = {
		system: [
			{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.302.abc; cc_entrypoint=cli;" },
			{ type: "text", text: CLAUDE_IDENTITY },
			{ type: "text", text: core },
		],
		messages: [
			{ role: "user", content: [{ type: "text", text: `[System Instructions]\n${runtime}` }] },
			{ role: "assistant", content: [{ type: "text", text: "Understood. I will follow these instructions." }] },
			{ role: "user", content: "real task" },
		],
	};
	const migrated = claudeCodePrompt(source);
	assert.deepEqual(migrated.messages.map((message) => object(message).role), ["system", "user"]);
	assert.equal(object(array(object(migrated.messages[0]).content)[0]).text, runtime);
	assert.deepEqual(claudeCodePrompt(migrated), migrated);
	const unrelated = claudeCodePrompt({ system: "Different system", messages: source.messages });
	assert.equal(unrelated.messages.length, 4);
	assert.deepEqual(unrelated.messages.slice(1), source.messages);
});

test("system blocks that cannot fit the approved text layout fail rather than lose data", () => {
	const source = { system: [{ type: "text", text: "Keep rules", blocks: [
		{ type: "tool_reference", name: "read" },
	] }], messages: [{ role: "user", content: "task" }] };
	const before = structuredClone(source);
	assert.throws(() => claudeCodePrompt(source), /unsupported.*system.*field/i);
	assert.deepEqual(source, before);
});

test("unknown and near project wrappers are runtime text, not keyword-based deletions", () => {
	const prefix = claudeCodePrompt({}).system[1].text;
	for (const system of [
		[{ type: "text", text: "x-anthropic-billing-header: user rule; cc_entrypoint=custom;" }, { type: "text", text: "Keep rules" }],
		[{ type: "text", text: prefix + "An ordinary instruction without the identity envelope." }],
		[{ type: "text", text: CLAUDE_IDENTITY + " " }, { type: "text", text: prefix + "Keep permissions" }],
	]) {
		const source = { system, messages: [{ role: "user", content: "task" }] };
		const result = claudeCodePrompt(source);
		assert.equal(object(array(object(result.messages[0]).content)[0]).text, system.map((block) => block.text).join("\n\n"));
		assert.deepEqual(result.messages.slice(1), source.messages);
		assert.deepEqual(claudeCodePrompt(result), result);
	}
});

test("equal initial and history system instructions keep both occurrences and their timing", () => {
	const source = { system: "Keep rules.  \n", messages: [
		{ role: "system", content: [{ type: "text", text: "Keep rules.  \n" }] },
		{ role: "user", content: "Start the task" },
		{ role: "system", content: [{ type: "text", text: "Updated permissions" }] },
		{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "file" } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }] },
	] };
	const before = structuredClone(source);
	const result = claudeCodePrompt(source);
	assert.equal(result.messages.length, 6);
	assert.deepEqual(result.messages[0], { role: "system", content: [{ type: "text", text: "Keep rules.  \n" }] });
	assert.deepEqual(result.messages.slice(1), source.messages);
	assert.deepEqual(claudeCodePrompt(result), result);
	assert.deepEqual(source, before);
});

test("near legacy ACK templates preserve the complete original system and conversation", () => {
	const current = claudeCodePrompt({});
	const core = current.system[1].text.split("\n# Runtime instructions\n")[0].trimEnd();
	const source = {
		system: [
			{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.302.abc; cc_entrypoint=cli;" },
			{ type: "text", text: CLAUDE_IDENTITY },
			{ type: "text", text: core },
		],
		messages: [
			{ role: "user", content: [{ type: "text", text: "[System Instructions]\nKeep permissions." }] },
			{ role: "assistant", content: [{ type: "text", text: "Understood. I will follow these instructions. " }] },
			{ role: "system", content: [{ type: "text", text: "Later permission update" }] },
		],
	};
	const before = structuredClone(source);
	const result = claudeCodePrompt(source);
	assert.equal(object(result.messages[0]).role, "system");
	assert.equal(object(array(object(result.messages[0]).content)[0]).text,
		`x-anthropic-billing-header: cc_version=2.1.302.abc; cc_entrypoint=cli;\n\n${CLAUDE_IDENTITY}\n\n${core}`);
	assert.deepEqual(result.messages.slice(1), source.messages);
	assert.deepEqual(claudeCodePrompt(result), result);
	assert.deepEqual(source, before);
});

test("legacy prefaces with extra message or text-block fields preserve the complete envelope", async (t) => {
	const core = claudeCodePrompt({}).system[1].text.split("\n# Runtime instructions\n")[0].trimEnd();
	for (const role of ["user", "assistant"]) {
		for (const target of ["message", "block"]) {
			for (const [field, value] of Object.entries({
				citations: [{ type: "char_location", cited_text: "Keep permissions.", start_char_index: 0, end_char_index: 17 }],
				custom: { preserve: ["opaque", "data"] },
			})) {
				await t.test(`${role}/${target}/${field}`, () => {
					const source = {
						system: [
							{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.302.abc; cc_entrypoint=cli;" },
							{ type: "text", text: CLAUDE_IDENTITY },
							{ type: "text", text: core },
						],
						messages: [
							{ role: "user", content: [{ type: "text", text: "[System Instructions]\nKeep permissions." }] },
							{ role: "assistant", content: [{ type: "text", text: "Understood. I will follow these instructions." }] },
							{ role: "user", content: [{ type: "text", text: "Actual task" }] },
						],
					};
					const message = source.messages[role === "user" ? 0 : 1];
					object(target === "message" ? message : message.content[0])[field] = value;
					const before = structuredClone(source);
					const result = claudeCodePrompt(source);
					assert.deepEqual(result.messages[0], { role: "system", content: [
						{ type: "text", text: source.system.map((block) => block.text).join("\n\n") },
					] });
					assert.deepEqual(result.messages.slice(1), source.messages);
					assert.deepEqual(claudeCodePrompt(result), result);
					assert.deepEqual(source, before);
				});
			}
		}
	}
});

test("native effort history, thinking fields and later rules survive unchanged", async () => {
	const input = {
		system: "Keep rules.",
		thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
		output_config: { effort: "low", format: { type: "json_schema" } },
		messages: [
			{ role: "system", content: [], output_config: { effort: "low" } },
			{ role: "user", content: [{ type: "text", text: "New prompt" }] },
			{ role: "system", content: [{ type: "text", text: "Real environment" }], output_config: { effort: "max", format: { type: "json_schema" } } },
		],
	};
	const before = structuredClone(input);
	const adapter = claudePayloadAdapter(SESSION_ID);
	const once = object(await adapter.onPayload(input, claudeModel()));
	assert.deepEqual(once.thinking, input.thinking);
	assert.deepEqual(once.output_config, input.output_config);
	const messages = array(once.messages).map(object);
	assert.deepEqual(messages.map((message) => message.role), ["system", "system", "user", "system"]);
	assert.equal(object(array(messages[3].content)[0]).text, "Real environment");
	assert.deepEqual(messages[1].output_config, { effort: "low" });
	assert.deepEqual(messages[3].output_config, input.messages[2].output_config);
	assert.deepEqual(input, before);
	assert.deepEqual(await adapter.onPayload(once, claudeModel()), once);
	await assert.rejects(adapter.onPayload(null, claudeModel()), /metadata|payload/);
	await assert.rejects(adapter.onPayload(undefined, claudeModel()), /metadata|payload/);
});
