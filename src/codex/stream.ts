// /compat is explicitly supported by the real Pi extension loader.
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { Api, Model, SimpleStreamOptions, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { prepareRelayRequest } from "../relay-transport.ts";
import { CODEX_PROFILE } from "./identity.ts";
import { codexPayloadAdapter } from "./payload.ts";

const native = openAIResponsesApi();

function streamCodex(
	model: Model<Api>, context: TranscriptContext, options: StreamOptions | undefined,
	delegate: typeof native.stream,
): ReturnType<typeof native.stream> {
	const request = prepareRelayRequest(CODEX_PROFILE, model, options);
	return delegate(request.model, context, {
		...request.options,
		onPayload: codexPayloadAdapter(options),
	});
}

/** Preserve both Pi stream contracts; no Claude tool-name mapping on this path. */
export function codexStream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions) {
	return streamCodex(model, context, options, native.stream);
}
export function codexStreamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
	return streamCodex(model, context, options, native.streamSimple);
}
