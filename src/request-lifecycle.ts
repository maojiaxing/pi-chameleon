import type {
	Api, AssistantMessageEventStream, Model, StreamOptions, TranscriptContext,
} from "@earendil-works/pi-ai";

export type AdapterOptions = Omit<StreamOptions, "onPayload">;
export interface PreparedPayload {
	value: unknown;
	finish(candidate: unknown): unknown;
}
export interface ReadyRequest<TApi extends Api> {
	model: Model<TApi>;
	options: AdapterOptions;
	prepare(payload: unknown, model: Model<Api>, hasHook: () => boolean): PreparedPayload;
	restore?(events: AssistantMessageEventStream): AssistantMessageEventStream;
}
type NativeDelegate<TApi extends Api> = (
	model: Model<TApi>, context: TranscriptContext, options?: StreamOptions,
) => AssistantMessageEventStream;

/**
 * Keep option reads live without exposing the caller's hook to an adapter.
 * A fresh target also supports frozen options with a non-configurable hook.
 * Existing option spreads read enumerable hook accessors even though native
 * never receives that hook; retain that read when enumerating this view.
 */
function adapterOptions(options: StreamOptions | undefined): AdapterOptions | undefined {
	if (!options) return undefined;
	return new Proxy({}, {
		get: (_target, key) => key === "onPayload" ? undefined : Reflect.get(options, key),
		has: (_target, key) => key !== "onPayload" && Reflect.has(options, key),
		ownKeys: () => Reflect.ownKeys(options),
		getOwnPropertyDescriptor(_target, key) {
			if (key === "onPayload") {
				// Object spread visits descriptors in key order. Preserve the
				// discarded accessor read at that same point, without exposing it.
				if (Object.getOwnPropertyDescriptor(options, key)?.enumerable) void options.onPayload;
				return undefined;
			}
			const descriptor = Object.getOwnPropertyDescriptor(options, key);
			return descriptor && { ...descriptor, configurable: true };
		},
	});
}

/** Fixed, synchronous request entry; only native payload callbacks are async. */
export function adaptedStream<TApi extends Api>(
	adapter: (model: Model<Api>, options?: AdapterOptions) => ReadyRequest<TApi>,
	delegate: NativeDelegate<TApi>, model: Model<Api>, context: TranscriptContext, options?: StreamOptions,
	// Existing callers differ in both capture time and receiver. This is hook
	// invocation policy, not protocol payload knowledge or an adapter capability.
	hookBinding: "captured" | "live-method" = "captured",
): AssistantMessageEventStream {
	const request = adapter(model, adapterOptions(options));
	const captured = hookBinding === "captured" ? options?.onPayload : undefined;
	const events = delegate(request.model, context, {
		...request.options,
		async onPayload(payload, nativeModel) {
			let hook = captured;
			let resolved = hookBinding === "captured";
			const currentHook = () => {
				if (!resolved) { hook = options?.onPayload; resolved = true; }
				return hook;
			};
			// Resolve live hooks only when preparation needs a protection
			// snapshot, or immediately before invocation. Payload option getters
			// and preparation errors therefore keep their original ordering.
			const prepared = request.prepare(payload, nativeModel, () => Boolean(currentHook()));
			const callback = currentHook();
			const replacement = await (callback == null ? undefined : Reflect.apply(
				callback, hookBinding === "captured" ? undefined : options, [prepared.value, nativeModel],
			));
			return prepared.finish(replacement === undefined ? prepared.value : replacement);
		},
	});
	return request.restore ? request.restore(events) : events;
}
