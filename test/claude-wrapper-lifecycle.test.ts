import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { restoredStream } from "../src/claude/tools.ts";

// Protocol-edge seam: a name-restoration failure cannot be produced by normal valid SSE.
test("a tool restoration exception emits an error and settles result instead of hanging", { timeout: 3000 }, async () => {
	const source = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant", content: [], api: "anthropic-messages", provider: "chameleon-claude", model: "synthetic-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: 1,
	};
	const wrapped = restoredStream(source, () => { throw new Error("private-wrapper-sentinel"); });
	source.push({ type: "done", reason: "stop", message });
	const result = await wrapped.result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /stream.*restoration/i);
	assert.doesNotMatch(result.errorMessage ?? "", /private-wrapper-sentinel/);
	const kinds: string[] = [];
	for await (const event of wrapped) kinds.push(event.type);
	assert.deepEqual(kinds, ["error"]);
});
