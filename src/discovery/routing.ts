import { normalizeContext, type Api, type Model, type SimpleStreamOptions, type StreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { claudeCodeStream, claudeCodeStreamSimple } from "../claude/stream.ts";
import { codexStream, codexStreamSimple } from "../codex/stream.ts";

// Mark the registered public handler, not this module instance: real extension reloads
// can evaluate another copy of this file while sharing the process-wide API registry.
const installed = Symbol.for("pi-chameleon.discovery.api-routing.v1");

/** Pi 1.5.0 dispatches explicit models via the global API when the base catalog is empty. */
export function installChameleonRouting(): void {
	for (const [api, provider, stream, streamSimple] of [
		["anthropic-messages", "chameleon-claude", claudeCodeStream, claudeCodeStreamSimple],
		["openai-responses", "chameleon-codex", codexStream, codexStreamSimple],
	] as const) {
		const original = getApiProvider(api);
		if (!original) throw new Error("CHAMELEON_ROUTING_UNAVAILABLE");
		if (Object.getOwnPropertyDescriptor(original, installed)?.value === true) continue;
		const matches = (model: Model<Api>) => model.provider === provider && model.api === api;
		registerApiProvider({
			api,
			stream: (model: Model<Api>, context: TranscriptContext, options?: StreamOptions) => matches(model)
				? stream(model, normalizeContext(context), options)
				: original.stream(model, context, options),
			streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => matches(model)
				? streamSimple(model, normalizeContext(context), options)
				: original.streamSimple(model, context, options),
		});
		const registered = getApiProvider(api);
		if (registered) Object.defineProperty(registered, installed, { value: true });
	}
}
