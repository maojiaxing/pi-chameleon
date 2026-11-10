import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticSession } from "./diagnostics-session.ts";
import { claudeTextResponse } from "./fixtures.ts";

test("observer failure at the fetch boundary is incomplete without blocking the legal stream", { timeout: 20_000 }, async () => {
	const h = await diagnosticSession();
	try {
		await h.command("on");
		h.setFetch(async () => {
			const response = claudeTextResponse();
			let firstRead = true;
			Object.defineProperty(response, "status", { get() {
				if (firstRead) { firstRead = false; throw new Error("private-observer-error-sentinel"); }
				return 200;
			} });
			return response;
		});
		await h.session.prompt("legal request");
		const status = await h.status();
		assert.equal(status.latest.terminal, "success");
		assert.equal(status.latest.incomplete, true);
		assert.equal(status.incomplete, true);
		assert.equal(status.latest.httpStatus, undefined);
		assert.ok(!JSON.stringify(status).includes("sentinel"));
	} finally { await h.close(); }
});
