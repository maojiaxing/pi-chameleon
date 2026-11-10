import assert from "node:assert/strict";
import { test } from "node:test";
import { claudePayloadAdapter } from "../src/claude/payload.ts";
import { claudeCodeStreamSimple } from "../src/claude/stream.ts";
import { codexStreamSimple } from "../src/codex/stream.ts";
import { API_KEY, SESSION_ID, capture, claudeModel, claudeTextResponse, codexModel, codexTextResponse, context, object } from "./fixtures.ts";

test("pre-hook identity normalization preserves opaque metadata and user_id extras", async () => {
	const source = {
		messages: [{ role: "user", content: "hello" }],
		metadata: {
			trace: { request: "keep-metadata" },
			user_id: JSON.stringify({ device_id: "replace", account_uuid: "replace", session_id: "replace", extra: { values: ["keep-user-id"] } }),
		},
	};
	const before = structuredClone(source);
	let calls = 0;
	const adapter = claudePayloadAdapter(SESSION_ID, (payload) => {
		calls++;
		const metadata = object(object(payload).metadata);
		const identity = JSON.parse(String(metadata.user_id));
		assert.deepEqual(metadata.trace, { request: "keep-metadata" });
		assert.deepEqual(identity.extra, { values: ["keep-user-id"] });
		assert.equal(identity.session_id, SESSION_ID);
		assert.equal(identity.account_uuid, "");
		assert.notEqual(identity.device_id, "replace");
		metadata.hook = "allowed";
		metadata.user_id = JSON.stringify({ ...identity, session_id: "hook-must-not-override" });
	});
	const result = object(await adapter.onPayload(source, claudeModel()));
	const metadata = object(result.metadata);
	assert.equal(calls, 1);
	assert.equal(metadata.hook, "allowed");
	assert.deepEqual(metadata.trace, source.metadata.trace);
	assert.deepEqual(JSON.parse(String(metadata.user_id)).extra, { values: ["keep-user-id"] });
	assert.equal(JSON.parse(String(metadata.user_id)).session_id, SESSION_ID);
	assert.deepEqual(source, before);
});

test("concurrent anonymous Claude requests keep independent identities across hook and fetch", async () => {
	const mock = capture(claudeTextResponse);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let arrived = 0;
	const observed: string[] = [];
	const results = await Promise.all(Array.from({ length: 2 }, () => claudeCodeStreamSimple(claudeModel(), context(), {
		apiKey: API_KEY, fetch: mock.fetch,
		async onPayload(value) {
			observed.push(JSON.parse(String(object(object(value).metadata).user_id)).session_id);
			if (++arrived === 2) release();
			await gate;
		},
	}).result()));
	for (const result of results) assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(new Set(observed).size, 2);
	for (const request of mock.requests) {
		const identity = JSON.parse(String(object(request.body.metadata).user_id));
		assert.ok(observed.includes(identity.session_id));
		assert.equal(request.headers.get("x-claude-code-session-id"), identity.session_id);
	}
	assert.equal(new Set(mock.requests.map((request) => JSON.parse(String(object(request.body.metadata).user_id)).device_id)).size, 1);
});

test("explicit Claude sessions retain UUIDs and deterministic path-free conversion", async () => {
	const mock = capture(claudeTextResponse);
	for (const sessionId of [SESSION_ID, "C:/synthetic/private/session.json", "C:/synthetic/private/session.json", "another-session"]) {
		const result = await claudeCodeStreamSimple(claudeModel(), context(), { apiKey: API_KEY, sessionId, fetch: mock.fetch }).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
	}
	const sessions = mock.requests.map((request) => request.headers.get("x-claude-code-session-id"));
	assert.equal(sessions[0], SESSION_ID);
	assert.equal(sessions[1], sessions[2]);
	assert.notEqual(sessions[2], sessions[3]);
	for (const request of mock.requests) {
		assert.doesNotMatch(JSON.stringify(request.body), /C:\/synthetic\/private\/session\.json/);
		assert.equal(JSON.parse(String(object(request.body.metadata).user_id)).session_id, request.headers.get("x-claude-code-session-id"));
	}
});

test("anonymous Codex requests retain the existing stable fallback contract", async () => {
	const mock = capture(codexTextResponse);
	for (let i = 0; i < 2; i++) {
		const result = await codexStreamSimple(codexModel(), context(), { apiKey: API_KEY, fetch: mock.fetch }).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
	}
	assert.ok(mock.requests[0].headers.get("session-id"));
	assert.equal(mock.requests[0].headers.get("session-id"), mock.requests[1].headers.get("session-id"));
});
