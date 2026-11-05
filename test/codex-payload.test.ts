import assert from "node:assert/strict";
import { test } from "node:test";
import { codexPayloadAdapter } from "../src/codex/payload.ts";
import { CODEX_IDENTITY, codexModel, object } from "./fixtures.ts";

// These exercise the internal payload lifecycle used by production, not an
// exported transformation helper. Wire behavior/caps/hooks live in stream tests.
test("Codex repeated assembly is idempotent and keeps later rules and source data", async () => {
	const source = {
		model: "gpt-5.5", input: [
			{ role: "developer", content: "You are a coding assistant running inside pi, a coding agent harness. Keep rules.\nExample: You are a coding assistant running inside pi, a coding agent harness." },
			{ role: "user", content: "Keep my original text" },
			{ role: "developer", content: "Actual later rule update" },
		],
	};
	const snapshot = structuredClone(source);
	const onPayload = codexPayloadAdapter();
	const once = object(await onPayload(source, codexModel()));
	const twice = object(await onPayload(once, codexModel()));
	assert.deepEqual(twice, once);
	assert.deepEqual(source, snapshot);
	const input = once.input as Record<string, unknown>[];
	assert.equal(input.length, 3);
	assert.equal(input[0].content, `${CODEX_IDENTITY}\n\nKeep rules.\nExample: You are a coding assistant running inside pi, a coding agent harness.`);
	assert.equal(input[1], source.input[1]);
	assert.equal(input[2], source.input[2]);
});

test("legacy top-level instructions migrate without loss and invalid payload shapes reject", async () => {
	const adapt = codexPayloadAdapter();
	const body = object(await adapt({ model: "gpt-5.5", input: [{ role: "user", content: "hi" }], instructions: "Keep exact rules." }, codexModel()));
	const input = body.input as Record<string, unknown>[];
	assert.equal(input[0].content, `${CODEX_IDENTITY}\n\nKeep exact rules.`);
	assert.equal(input[1].role, "user");
	assert.ok(!("instructions" in body));
	assert.deepEqual(await adapt(body, codexModel()), body);
	await assert.rejects(async () => adapt(null, codexModel()), /must be an object/);
	await assert.rejects(async () => adapt({ input: "oops" }, codexModel()), /must be an array/);
	await assert.rejects(async () => adapt({ input: [], instructions: {} }, codexModel()), /must be text/);
});
