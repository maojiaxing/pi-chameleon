import assert from "node:assert/strict";
import { test } from "node:test";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { adaptedStream } from "../src/request-lifecycle.ts";
import { API_KEY, capture, codexModel, codexTextResponse, context } from "./fixtures.ts";

// Object identity cannot be observed from fetch. Use the documented internal
// native-delegate seam, retaining a real Pi delegate and controlled transport.
test("a request without restoration returns the exact unconsumed native stream", async () => {
	const native = openAIResponsesApi();
	for (const delegate of [native.stream, native.streamSimple]) {
		const mock = capture(codexTextResponse);
		let original: ReturnType<typeof delegate> | undefined;
		const events = adaptedStream((model, options) => ({
			model: { ...codexModel(), ...model, api: "openai-responses" },
			options: options ?? {},
			prepare: (value) => ({ value, finish: (candidate) => candidate }),
		}), (model, transcript, options) => {
			original = delegate(model, transcript, options);
			return original;
		}, codexModel(), context(), { apiKey: API_KEY, fetch: mock.fetch });
		assert.equal(events, original);
		const types: string[] = [];
		for await (const event of events) types.push(event.type);
		assert.equal(types[0], "start");
		assert.equal(types.at(-1), "done");
		assert.equal((await events.result()).stopReason, "stop");
		assert.equal(mock.requests.length, 1);
	}
});
