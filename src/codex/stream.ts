// /compat is explicitly supported by the real Pi extension loader.
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { Api, Model, SimpleStreamOptions, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { adaptedStream, type AdapterOptions, type ReadyRequest } from "../request-lifecycle.ts";
import { prepareRelayRequest } from "../relay-transport.ts";
import { CODEX_PROFILE } from "./identity.ts";
import { prepareCodexPayload } from "./payload.ts";

const native = openAIResponsesApi();

function codexRequest(model: Model<Api>, options?: AdapterOptions): ReadyRequest<"openai-responses"> {
	const request = prepareRelayRequest(CODEX_PROFILE, model, options);
	return {
		...request,
		prepare: (payload, nativeModel) => prepareCodexPayload(payload, nativeModel, options),
	};
}

/** Preserve both Pi stream contracts; no Claude tool-name mapping on this path. */
export function codexStream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions) {
	return adaptedStream(codexRequest, native.stream, model, context, options, "live-method");
}
export function codexStreamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
	return adaptedStream(codexRequest, native.streamSimple, model, context, options, "live-method");
}
