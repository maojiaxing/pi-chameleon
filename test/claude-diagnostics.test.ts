import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticSession, deferred } from "./diagnostics-session.ts";
import { claudeTextResponse } from "./fixtures.ts";

for (const discovered of [false, true]) test(`diagnostics are opt-in and observe a real ${discovered ? "discovered" : "explicit empty-catalog"} chat`, { timeout: 20_000 }, async () => {
	const h = await diagnosticSession({ discovered });
	try {
		let requests = 0;
		h.setFetch(async () => { requests++; return claudeTextResponse(); });
		assert.deepEqual(await h.status(), { enabled: false, incomplete: false, inflight: [], latest: null });
		await h.session.prompt("private-prompt-sentinel");
		assert.equal(requests, 1);
		assert.equal((await h.status()).latest, null);
		await h.command("on");
		await h.session.prompt("private-second-prompt-sentinel");
		const status = await h.status();
		assert.equal(requests, 2);
		assert.equal(status.enabled, true);
		assert.equal(status.incomplete, false);
		assert.deepEqual(status.inflight, []);
		assert.deepEqual(status.latest.stages, ["adapted", "final-observed", "dispatched", "http", "terminal"]);
		assert.equal(status.latest.httpStatus, 200);
		assert.equal(status.latest.terminal, "success");
		assert.equal(status.latest.identityConsistent, true);
		assert.match(status.latest.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
		assert.ok(!JSON.stringify(status).includes("sentinel"));
	} finally { await h.close(); }
});

test("off and real reload clear the epoch and discard late responses", { timeout: 40_000 }, async () => {
	const h = await diagnosticSession();
	try {
		await h.command("on");
		const pending = deferred<Response>();
		const entered = deferred<void>();
		const stream = h.registry.streamSimple(h.model, { messages: [{ role: "user", content: "private-reload-prompt", timestamp: 0 }] }, {
			apiKey: "private-reload-key", sessionId: h.manager.getSessionId(), fetch: async () => { entered.resolve(); return pending.promise; },
		});
		await entered.promise;
		assert.equal((await h.status()).inflight.length, 1);
		await h.command("off");
		assert.deepEqual(await h.status(), { enabled: false, incomplete: false, inflight: [], latest: null });
		await h.command("on");
		pending.resolve(claudeTextResponse());
		await stream.result();
		assert.equal((await h.status()).latest, null);
		const late = deferred<Response>();
		const started = deferred<void>();
		const old = h.registry.streamSimple(h.model, { messages: [] }, { apiKey: "key", sessionId: h.manager.getSessionId(),
			fetch: async () => { started.resolve(); return late.promise; } });
		await started.promise;
		await h.session.reload();
		assert.deepEqual(await h.status(), { enabled: false, incomplete: false, inflight: [], latest: null });
		await h.command("on");
		late.resolve(claudeTextResponse());
		await old.result();
		assert.equal((await h.status()).latest, null);
		await h.session.prompt("new epoch request");
		assert.equal((await h.status()).latest.terminal, "success");
	} finally { await h.close(); }
});

test("overlapping requests keep independent IDs, latest completion and an eight-request bound", { timeout: 30_000 }, async () => {
	const h = await diagnosticSession();
	try {
		await h.command("on");
		const pending = Array.from({ length: 9 }, () => deferred<Response>());
		const entered = Array.from({ length: 9 }, () => deferred<void>());
		const streams = pending.map((item, i) => h.registry.streamSimple(h.model, { messages: [] }, {
			apiKey: "key", sessionId: h.manager.getSessionId(), fetch: async () => { entered[i]!.resolve(); return item.promise; },
		}));
		await Promise.all(entered.map((item) => item.promise));
		const status = await h.status();
		assert.equal(status.incomplete, true);
		assert.equal(status.inflight.length, 8);
		assert.equal(new Set(status.inflight.map((item: any) => item.id)).size, 8);
		assert.ok(status.inflight.every((item: any) => !item.stages.includes("dispatched")));
		pending[1]!.resolve(claudeTextResponse());
		await streams[1]!.result();
		assert.equal((await h.status()).latest.id, status.inflight[1].id);
		pending[0]!.resolve(new Response("private-http-sentinel", { status: 400 }));
		await streams[0]!.result();
		const completed = await h.status();
		assert.equal(completed.latest.id, status.inflight[0].id);
		assert.equal(completed.latest.httpStatus, 400);
		assert.equal(completed.latest.terminal, "error");
		for (let i = 2; i < 9; i++) pending[i]!.resolve(claudeTextResponse());
		await Promise.all(streams.map((stream) => stream.result()));
		assert.equal((await h.status()).inflight.length, 0);
		await h.command("off");
		assert.equal((await h.status()).incomplete, false);
	} finally { await h.close(); }
});

test("two extension instances isolate sessions and ambiguous duplicate ownership refuses attribution", { timeout: 50_000 }, async () => {
	const a = await diagnosticSession();
	const b = await diagnosticSession();
	try {
		await a.command("on");
		await b.session.prompt("disabled second instance");
		assert.equal((await a.status()).latest, null);
		assert.equal((await b.status()).latest, null);
		await b.command("on");
		await Promise.all([a.session.prompt("first"), b.session.prompt("second")]);
		assert.notEqual((await a.status()).latest.id, (await b.status()).latest.id);
		await a.command("off");
		assert.equal((await b.status()).latest.terminal, "success");
		const duplicate = await diagnosticSession({ manager: b.manager });
		try {
			await duplicate.command("on");
			await b.command("off"); await b.command("on");
			await b.session.prompt("ambiguous ownership request");
			for (const h of [b, duplicate]) {
				const status = await h.status();
				assert.equal(status.incomplete, true);
				assert.equal(status.latest, null);
			}
		} finally { await duplicate.close(); }
		await b.session.prompt("duplicate removed");
		assert.equal((await b.status()).latest.terminal, "success");
	} finally { await a.close(); await b.close(); }
});