import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { claudeCodeStreamSimple } from "../src/claude/stream.ts";
import { claudePayloadAdapter } from "../src/claude/payload.ts";
import { claudeCodeSystem } from "../src/claude/prompts.ts";
import {
	API_KEY, SESSION_ID, CLAUDE_IDENTITY, claudeModel, claudeTextResponse,
	capture, object, array,
} from "./fixtures.ts";

// Normal prompt behavior is tested through streamSimple. Internal seams below
// cover malformed/legacy wire forms and repeated assembly the SDK can't emit.
async function request(prompt?: string) {
	const mock = capture(claudeTextResponse);
	const result = await claudeCodeStreamSimple(claudeModel(), normalizeContext({
		systemPrompt: prompt, messages: [{ role: "user", content: "hello", timestamp: 1 }],
	}), { apiKey: API_KEY, reasoning: "high", sessionId: SESSION_ID, fetch: mock.fetch }).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	return mock.requests[0].body;
}

test("Claude request preserves runtime/project text, replaces only the initial identity and caches the final user", async () => {
	const prompt = "You are an expert coding assistant operating inside pi. Help users.\n\n<rules>Example: You are an expert coding assistant operating inside pi.</rules>\n<cwd>/actual/project</cwd>";
	const body = await request(prompt);
	const system = array(body.system).map(object);
	assert.equal(system.length, 2);
	assert.equal(system[0].text, CLAUDE_IDENTITY);
	const main = String(system[1].text);
	assert.ok(main.endsWith(prompt.replace("You are an expert coding assistant operating inside pi.", CLAUDE_IDENTITY)));
	assert.ok(main.includes("# Runtime instructions"));
	assert.ok(main.includes("Runtime-specific instructions take precedence"));
	for (const block of system) assert.deepEqual(block.cache_control, { type: "ephemeral" });
	const user = array(body.messages).map(object).findLast((message) => message.role === "user");
	assert.ok(user);
	assert.deepEqual(object(array(user.content)[0]).cache_control, { type: "ephemeral" });
	assert.deepEqual(body.context_management, { edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
});

test("empty runtime still sends a two-block Claude core without fabricated capabilities", async () => {
	const body = await request();
	const blocks = array(body.system).map(object);
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].text, CLAUDE_IDENTITY);
	const text = String(blocks[1].text);
	assert.ok(text.startsWith("You are an agent working with the user toward their goals, using your own judgment along the way."));
	for (const section of ["# Harness", "# Context management", "# Runtime instructions"]) assert.ok(text.includes(section));
	for (const omitted of ["# Memory", "# Environment", "<total_tokens>", "Available agent types", "Set model to", "Claude Agent SDK"]) assert.ok(!text.includes(omitted), omitted);
});

test("prompt module handles legacy prefix cleanup, multiple blocks, quoting and repeated assembly", () => {
	const billing = "x-anthropic-billing-header: cc_version=2.1.220.e92; cc_entrypoint=sdk-cli;";
	const quoted = `<project_context>Example text: ${billing}</project_context>`;
	const source = [
		{ type: "text", text: billing },
		{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." },
		{ type: "text", text: "You are a coding assistant running inside pi, a coding agent harness. Keep rules." },
		{ type: "text", text: quoted },
	];
	const before = structuredClone(source);
	const blocks = claudeCodeSystem(source);
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].text, CLAUDE_IDENTITY);
	assert.ok(blocks[1].text.endsWith(`${CLAUDE_IDENTITY} Keep rules.\n\n${quoted}`));
	assert.ok(!blocks[1].text.includes("Claude Agent SDK"));
	assert.deepEqual(claudeCodeSystem(blocks), blocks);
	assert.deepEqual(source, before);
	assert.deepEqual(claudeCodeSystem(undefined), claudeCodeSystem([]));
	assert.deepEqual(claudeCodeSystem("Keep rules."), claudeCodeSystem([{ type: "text", text: "Keep rules." }]));
	assert.throws(() => claudeCodeSystem({ text: "invalid" }), /string or text-block array/);
	assert.throws(() => claudeCodeSystem([{ type: "image", text: "invalid" }]), /non-text block/);
});

test("Claude payload lifecycle is idempotent, updates effort and does not mutate source", async () => {
	const input = {
		system: [{ type: "text", text: "Keep rules." }],
		thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
		output_config: { effort: "low", format: { type: "json_schema" } },
		messages: [
			{ role: "system", content: [], output_config: { effort: "low" } },
			{ role: "assistant", content: [{ type: "text", text: "Old reply" }] },
			{ role: "user", content: [{ type: "text", text: "New prompt" }] },
			{ role: "system", content: [{ type: "text", text: "Real environment" }] },
			{ role: "system", content: [], output_config: { effort: "max" } },
		],
	};
	const before = structuredClone(input);
	const adapter = claudePayloadAdapter(SESSION_ID);
	const body = object(await adapter.onPayload(input, claudeModel()));
	assert.deepEqual(body.thinking, { type: "adaptive", display: "updates" });
	assert.deepEqual(body.output_config, { effort: "max", format: { type: "json_schema" } });
	const messages = array(body.messages).map(object);
	assert.equal(messages.length, 4);
	assert.deepEqual(messages[0].output_config, { effort: "low" });
	assert.deepEqual(messages[3].output_config, { effort: "max" });
	assert.equal(object(array(messages[3].content)[0]).text, "Real environment");
	assert.deepEqual(input, before);
	const twice = object(await adapter.onPayload(body, claudeModel()));
	assert.deepEqual(twice.system, body.system);
	assert.equal(await adapter.onPayload(null, claudeModel()), null);
	assert.equal(await adapter.onPayload(undefined, claudeModel()), undefined);
});
