import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticSession, deferred } from "./diagnostics-session.ts";
import { claudeTextResponse, claudeStart, sse } from "./fixtures.ts";

for (const raw of [false, true]) test(`${raw ? "raw" : "simple"} hook runs once; final wire projection is safe and diagnostics do not change the request`, { timeout: 30_000 }, async () => {
	const h = await diagnosticSession();
	try {
		const wires: string[] = [];
		let hooks = 0;
		let transientInconsistent = false;
		for (const enabled of [false, true]) {
			await h.command(enabled ? "on" : "off");
			const stream = h.registry[raw ? "stream" : "streamSimple"](h.model, {
				messages: [{ role: "user", content: "private-prompt-sentinel", timestamp: 0 }],
			}, {
				sessionId: h.manager.getSessionId(), apiKey: "private-key-sentinel", headers: { "X-Private": "private-header-sentinel" },
				onPayload(payload) {
					hooks++;
					const body = payload as Record<string, any>;
					body.metadata.user_id = JSON.stringify({ session_id: "private-session-sentinel", device_id: "private-device-sentinel" });
					transientInconsistent = true;
					return { ...body, model: "private-model-sentinel", extra: "private-unknown-sentinel",
						tools: [{ name: "private-tool-sentinel", description: "private-description-sentinel", input_schema: { type: "object", properties: { private: { const: "private-schema-sentinel" } } } }],
						messages: [{ role: "user", content: [{ type: "text", text: "private-result-sentinel" },
							{ type: "tool_use", id: "private-call-sentinel", name: "private-tool-sentinel", input: { secret: "private-params-sentinel" } }] }],
					};
				},
				fetch: async (_input, init) => {
					wires.push(String(init?.body));
					const response = claudeTextResponse();
					response.clone = () => { throw new Error("diagnostics must not clone response"); };
					return response;
				},
			});
			const events: string[] = [];
			for await (const event of stream) events.push(event.type);
			assert.equal((await stream.result()).stopReason, "stop");
			assert.ok(events.includes("text_delta"));
		}
		assert.equal(hooks, 2);
		assert.equal(wires[0], wires[1]);
		assert.equal(transientInconsistent, true);
		const status = await h.status();
		assert.equal(status.latest.toolCount, 1);
		assert.equal(status.latest.blockCount, 4);
		assert.equal(status.latest.identityConsistent, true);
		assert.equal(status.latest.cache, "short");
		assert.ok(!JSON.stringify(status).includes("sentinel"));
		assert.deepEqual(Object.keys(status.latest).sort(), ["id", "rules", "stages", "incomplete", "toolCount", "blockCount", "cache", "identityConsistent", "httpStatus", "terminal"].sort());
	} finally { await h.close(); }
});

test("HTTP, late SSE failure, hook rejection and transport throw stay distinct without changing retries", { timeout: 40_000 }, async () => {
	const h = await diagnosticSession();
	try {
		for (const scenario of ["http", "sse", "hook", "transport"] as const) {
			await h.command("off"); await h.command("on");
			let hooks = 0;
			let calls = 0;
			const stream = h.registry.streamSimple(h.model, { messages: [] }, { apiKey: "private-key-sentinel", sessionId: h.manager.getSessionId(),
				onPayload() { hooks++; if (scenario === "hook") throw new Error("private-hook-error-sentinel"); },
				fetch: async () => {
					calls++;
					if (scenario === "transport") throw new Error("private-transport-error-sentinel");
					if (scenario === "http") return new Response("private-http-body-sentinel", { status: 403 });
					return sse([claudeStart(), { type: "error", error: { type: "overloaded_error", message: "private-sse-error-sentinel" } }]);
				},
			});
			assert.equal((await stream.result()).stopReason, "error");
			const summary = (await h.status()).latest;
			assert.equal(hooks, 1);
			assert.equal(summary.terminal, "error");
			assert.equal(summary.failure, { http: "http-error", sse: "stream-error", hook: "hook", transport: "transport-unknown" }[scenario]);
			assert.equal(summary.httpStatus, scenario === "http" ? 403 : scenario === "sse" ? 200 : undefined);
			assert.equal(summary.stages.includes("dispatched"), scenario === "http" || scenario === "sse");
			assert.equal(summary.stages.includes("adapted"), true);
			assert.equal(summary.stages.includes("final-observed"), scenario !== "hook");
			assert.ok(!JSON.stringify(summary).includes("sentinel"));
			// Compare native attempt count with diagnostics off rather than assume an SDK retry policy.
			await h.command("off");
			let baseline = 0;
			await h.registry.streamSimple(h.model, { messages: [] }, { apiKey: "key", sessionId: h.manager.getSessionId(),
				onPayload() { if (scenario === "hook") throw new Error("baseline hook"); },
				fetch: async () => { baseline++; if (scenario === "transport") throw new Error("baseline transport");
					return scenario === "http" ? new Response("baseline", { status: 403 }) : sse([claudeStart(), { type: "error", error: { type: "overloaded_error", message: "baseline" } }]); },
			}).result();
			assert.equal(calls, baseline);
		}
	} finally { await h.close(); }
});

test("cancellation, safety rejection and UI failures remain business-independent", { timeout: 30_000 }, async () => {
	const h = await diagnosticSession();
	try {
		await h.command("on");
		const controller = new AbortController();
		const entered = deferred<void>();
		const stream = h.registry.streamSimple(h.model, { messages: [] }, { apiKey: "key", sessionId: h.manager.getSessionId(), signal: controller.signal,
			fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
				init!.signal!.addEventListener("abort", () => reject(new Error("private-abort-error-sentinel")), { once: true });
				entered.resolve();
			}),
		});
		await entered.promise;
		controller.abort();
		assert.equal((await stream.result()).stopReason, "aborted");
		assert.equal((await h.status()).latest.terminal, "cancelled");
		assert.equal((await h.status()).latest.stages.includes("dispatched"), false);
		h.failUI(true);
		await h.command("status");
		await h.session.prompt("legal despite notification failure");
		h.failUI(false);
		assert.equal((await h.status()).latest.terminal, "success");
		assert.equal((await h.status()).incomplete, true);
		for (const command of ["off", "on"]) {
			await h.command(command);
			let sent = false;
			const blocked = h.registry.streamSimple({ ...h.model, baseUrl: "https://private-user:private-pass@example.test" }, { messages: [] }, {
				apiKey: "key", sessionId: h.manager.getSessionId(), fetch: async () => { sent = true; return claudeTextResponse(); },
			});
			assert.equal((await blocked.result()).stopReason, "error");
			assert.equal(sent, false);
		}
		assert.equal((await h.status()).latest.stages.includes("final-observed"), false);
		await h.command("invalid-private-sentinel");
		assert.equal(h.notifications.at(-1), "Usage: /chameleon-diagnostics on|off|status");
	} finally { await h.close(); }
});
