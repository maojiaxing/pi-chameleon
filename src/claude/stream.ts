// /compat is explicitly supported by the real Pi extension loader.
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import type { Api, Model, SimpleStreamOptions, StreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { prepareRelayRequest } from "../relay-transport.ts";
import { CLAUDE_PROFILE, CLAUDE_SERIALIZER_COMPAT } from "./identity.ts";
import { claudePayloadAdapter } from "./payload.ts";
import { restoredStream } from "./tools.ts";

const native = anthropicMessagesApi();

function streamClaude(
	model: Model<Api>, context: TranscriptContext, options: StreamOptions | undefined,
	delegate: typeof native.stream,
): ReturnType<typeof native.stream> {
	// An injected SDK client skips native fetch construction and could bypass
	// the relay credential guard. Pi's fetch injection is the supported seam.
	if (options && "client" in options && options.client !== undefined) {
		throw new Error("pi-chameleon uses fetch injection, not a custom Anthropic client");
	}
	const request = prepareRelayRequest(CLAUDE_PROFILE, model, options);
	// Select the native non-strict serializer while preserving native thinking decisions.
	const wireModel = {
		...request.model,
		compat: {
			...request.model.compat,
			...CLAUDE_SERIALIZER_COMPAT,
		},
	};
	const payload = claudePayloadAdapter(request.options.sessionId, options?.onPayload);
	const events = delegate(wireModel, context, {
		...request.options,
		async onPayload(params, nativeModel) {
			const nativeParams = params as Record<string, unknown>;
			const betas = Array.isArray(nativeParams.betas) ? [...nativeParams.betas] : undefined;
			const adapted = await payload.onPayload(params, nativeModel);
			if (typeof adapted === "object" && adapted !== null && !Array.isArray(adapted)) {
				const protectedPayload = { ...adapted } as Record<string, unknown>;
				if (betas === undefined) delete protectedPayload.betas;
				else protectedPayload.betas = betas;
				return protectedPayload;
			}
			return adapted;
		},
	});
	return restoredStream(events, payload.fromWire);
}

/** Preserve both Pi stream contracts; only the native delegate interprets options. */
export function claudeCodeStream(model: Model<Api>, context: TranscriptContext, options?: StreamOptions) {
	return streamClaude(model, context, options, native.stream);
}
export function claudeCodeStreamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
	return streamClaude(model, context, options, native.streamSimple);
}
