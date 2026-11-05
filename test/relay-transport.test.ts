import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { prepareRelayRequest, type RelayProfile } from "../src/relay-transport.ts";
import { CLAUDE_PROFILE } from "../src/claude/identity.ts";
import { CODEX_PROFILE } from "../src/codex/identity.ts";
import { API_KEY, SESSION_ID, BASE_URL, claudeModel, codexModel } from "./fixtures.ts";

const adapters: { profile: RelayProfile<Api>; model: Model<Api>; path: string }[] = [
	{ profile: CLAUDE_PROFILE, model: claudeModel(), path: "/v1/messages" },
	{ profile: CODEX_PROFILE, model: codexModel(), path: "/v1/responses" },
];

for (const { profile, model, path } of adapters) {
	test(`${profile.provider}: shared transport enforces headers and preserves request bodies`, async () => {
		const captured: Request[] = [];
		const prepared = prepareRelayRequest(profile, model, {
			apiKey: API_KEY, sessionId: SESSION_ID,
			headers: {
				Authorization: "Bearer unwanted", "X-Api-Key": "unwanted", "API-Key": "unwanted",
				"Proxy-Authorization": "unwanted", Cookie: "unwanted", "ChatGPT-Account-ID": "unwanted",
				"x-openai-actor-authorization": "unwanted", "cf-aig-authorization": "unwanted",
				"X-Remove": null, "X-Extra": "caller", "USER-AGENT": "unwanted",
			},
			fetch: async (input, init) => { captured.push(new Request(input, init)); return new Response("{}"); },
		});
		assert.equal(prepared.options.apiKey, undefined);
		assert.equal(prepared.options.sessionId, SESSION_ID);
		assert.equal(prepared.options.timeoutMs, 600_000);
		assert.equal(prepared.options.maxRetries, 0);
		const controller = new AbortController();
		const fetch = prepared.options.fetch!;
		const url = `${BASE_URL}${path}?route=fixture`;
		const inherited = { "X-Remove": "must disappear", "x-extra": "sdk", "Authorization": "Bearer sdk" };
		await fetch(url, { method: "POST", body: '{"fixture":1}', headers: inherited, signal: controller.signal, redirect: "follow" });
		await fetch(new URL(url), { method: "POST", body: '{"fixture":2}', headers: inherited });
		await fetch(new Request(url, { method: "POST", body: '{"fixture":3}', headers: inherited }));
		for (const [i, request] of captured.entries()) {
			assert.equal(request.method, "POST");
			assert.equal(await request.text(), `{"fixture":${i + 1}}`);
			assert.equal(request.redirect, "error");
			assert.equal(request.headers.get("x-remove"), null);
			assert.equal(request.headers.get("x-extra"), "caller");
			assert.equal(request.headers.get("authorization"), profile.auth === "bearer" ? `Bearer ${API_KEY}` : null);
			assert.equal(request.headers.get("x-api-key"), profile.auth === "x-api-key" ? API_KEY : null);
			assert.notEqual(request.headers.get("user-agent"), "unwanted");
			for (const name of ["api-key", "proxy-authorization", "cookie", "chatgpt-account-id", "x-openai-actor-authorization", "cf-aig-authorization"]) {
				assert.equal(request.headers.get(name), null, name);
			}
			const routed = new URL(request.url);
			assert.equal(routed.searchParams.get("route"), "fixture");
			assert.equal(routed.searchParams.get("beta"), profile.api === "anthropic-messages" ? "true" : null);
		}
		controller.abort();
		assert.equal(captured[0].signal.aborted, true);
	});

	test(`${profile.provider}: rejects unsafe destinations before calling fetch`, async () => {
		let calls = 0;
		const key = "never-echo-this-secret";
		const request = prepareRelayRequest(profile, model, { apiKey: key, fetch: async () => { calls++; return new Response("{}"); } });
		for (const url of [
			"https://other.example.com/v1/messages", "http://relay.example.com/v1/messages",
			"https://relay.example.com:444/v1/messages", "https://user:never-echo-this-secret@relay.example.com/v1/messages",
			"ftp://relay.example.com", "not-a-url-never-echo-this-secret",
		]) {
			await assert.rejects(request.options.fetch!(url), (error: Error) => {
				assert.doesNotMatch(error.message, /never-echo-this-secret/);
				assert.match(error.message, /outside the configured relay|credentials|HTTP or HTTPS|invalid/);
				return true;
			});
		}
		assert.equal(calls, 0);
		for (const baseUrl of ["ftp://relay.example.com", "https://user:never-echo-this-secret@relay.example.com", "invalid"]) {
			assert.throws(() => prepareRelayRequest(profile, { ...model, baseUrl }, { apiKey: key }), /HTTP or HTTPS|credentials|invalid/);
		}
	});

	test(`${profile.provider}: isolates credentials and generates stable path-free session IDs`, async () => {
		const captured: Headers[] = [];
		const options = { sessionId: "C:/synthetic/session.json", fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			captured.push(new Request(input, init).headers); return new Response("{}");
		} };
		const a = prepareRelayRequest(profile, model, { ...options, apiKey: "key-a" });
		const b = prepareRelayRequest(profile, model, { ...options, apiKey: "key-b", timeoutMs: 12_345, maxRetries: 2 });
		assert.equal(a.options.sessionId, b.options.sessionId);
		assert.match(a.options.sessionId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
		assert.equal(b.options.timeoutMs, 12_345);
		assert.equal(b.options.maxRetries, 2);
		await Promise.all([a.options.fetch!(`${BASE_URL}${path}`), b.options.fetch!(`${BASE_URL}${path}`)]);
		const header = profile.auth === "bearer" ? "authorization" : "x-api-key";
		assert.deepEqual(captured.map((headers) => headers.get(header)), profile.auth === "bearer" ? ["Bearer key-a", "Bearer key-b"] : ["key-a", "key-b"]);
		for (const key of [undefined, "", "   "]) assert.throws(() => prepareRelayRequest(profile, model, { apiKey: key }), /No API key/);
		assert.throws(() => prepareRelayRequest(profile, { ...model, api: "unsupported" }, { apiKey: API_KEY }), /requires/);
	});
}

test("Codex omits foreign fingerprints after SDK and caller merging", async () => {
	let captured: Headers | undefined;
	const foreign = { "x-stainless-os": "unwanted", "anthropic-beta": "unwanted", "OpenAI-Beta": "unwanted", "session_id": "unwanted", "x-codex-installation-id": "unwanted", "x-claude-code-session-id": "unwanted" };
	const request = prepareRelayRequest(CODEX_PROFILE, codexModel(), {
		apiKey: API_KEY, headers: foreign,
		fetch: async (input, init) => { captured = new Request(input, init).headers; return new Response("{}"); },
	});
	await request.options.fetch!(`${BASE_URL}/v1/responses`, { headers: foreign });
	assert.ok(captured);
	for (const name of Object.keys(foreign)) assert.equal(captured.get(name), null, name);
});

test("shared safety checks also run after an adapter rewrites a URL", async () => {
	let calls = 0;
	for (const rewriteUrl of [
		(url: URL) => { url.hostname = "other.example.com"; },
		(url: URL) => { url.username = "fixture"; url.password = "fixture-secret"; },
	]) {
		const request = prepareRelayRequest({ ...CODEX_PROFILE, rewriteUrl }, codexModel(), {
			apiKey: API_KEY, fetch: async () => { calls++; return new Response("{}"); },
		});
		await assert.rejects(request.options.fetch!(`${BASE_URL}/v1/responses`), /outside the configured relay|credentials/);
	}
	assert.equal(calls, 0);
});

test("base URLs retain Pi semantics; only Claude messages receive the required beta query", async () => {
	for (const baseUrl of [BASE_URL, `${BASE_URL}/gateway/openai/`, `${BASE_URL}/v1/?route=fixture`]) {
		const request = prepareRelayRequest(CODEX_PROFILE, { ...codexModel(), baseUrl }, { apiKey: API_KEY });
		assert.equal(request.model.baseUrl, baseUrl);
	}
	let url: string | undefined;
	const request = prepareRelayRequest(CLAUDE_PROFILE, claudeModel(), { apiKey: API_KEY, fetch: async (input) => { url = String(input); return new Response("{}"); } });
	await request.options.fetch!(`${BASE_URL}/v1/models`);
	assert.equal(url, `${BASE_URL}/v1/models`);
});
