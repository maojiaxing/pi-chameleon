import type { Api, FetchFunction, Model, ProviderHeaders, StreamOptions } from "@earendil-works/pi-ai";
import { sessionUuid } from "./identity.ts";

/** The two CLI adapters supply only the wire differences, never safety policy. */
export interface RelayProfile<TApi extends Api> {
	provider: string;
	api: TApi;
	auth: "x-api-key" | "bearer";
	headers(sessionId: string): ProviderHeaders;
	rewriteUrl?(url: URL): void;
	omitHeader?(name: string): boolean;
}

const CREDENTIAL_HEADERS = new Set([
	"authorization", "x-api-key", "api-key", "proxy-authorization", "cookie",
	"cf-aig-authorization", "chatgpt-account-id", "x-openai-actor-authorization",
]);

function checkedUrl(value: string): URL {
	if (!value) throw new Error("pi-chameleon: configure this provider's baseUrl in Pi models.json");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		// Do not include the URL: a malformed value can itself contain a key.
		throw new Error("pi-chameleon relay URL is invalid");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("pi-chameleon relay must use HTTP or HTTPS");
	}
	if (url.username || url.password) {
		throw new Error("pi-chameleon relay URLs must not contain credentials");
	}
	return url;
}


/** Normalize before merging, retaining null deletions through SDK assembly. */
function mergeHeaders(target: ProviderHeaders, source: ProviderHeaders): void {
	for (const [name, value] of Object.entries(source)) target[name.toLowerCase()] = value;
}

function requestHeaders<TApi extends Api>(
	profile: RelayProfile<TApi>, sessionId: string, apiKey: string,
	caller: ProviderHeaders | undefined, inherited: ProviderHeaders = {},
): ProviderHeaders {
	const headers: ProviderHeaders = {};
	mergeHeaders(headers, inherited);
	mergeHeaders(headers, caller ?? {});
	// Pi's native authHeader:true has already resolved the configured key and
	// supplied this Bearer header. Honor it without parsing models.json or
	// accepting an unrelated inherited credential.
	const useBearer = profile.auth === "bearer" || headers.authorization === `Bearer ${apiKey}`;
	mergeHeaders(headers, profile.headers(sessionId));
	for (const name of Object.keys(headers)) {
		if (profile.omitHeader?.(name)) headers[name] = null;
	}
	// Clear alternate credential channels after all user/SDK/profile merging.
	for (const name of CREDENTIAL_HEADERS) headers[name] = null;
	if (useBearer) headers.authorization = `Bearer ${apiKey}`;
	else headers["x-api-key"] = apiKey;
	return headers;
}

function relayFetch<TApi extends Api>(
	profile: RelayProfile<TApi>, baseUrl: string, apiKey: string, sessionId: string,
	headers: ProviderHeaders | undefined, transport: FetchFunction,
): FetchFunction {
	const origin = checkedUrl(baseUrl).origin;
	return async (input, init) => {
		const originalUrl = input instanceof Request ? input.url : input.toString();
		const url = checkedUrl(originalUrl);
		if (url.origin !== origin) {
			throw new Error("pi-chameleon refuses to send credentials outside the configured relay");
		}
		profile.rewriteUrl?.(url);
		if (checkedUrl(url.toString()).origin !== origin) {
			throw new Error("pi-chameleon refuses to send credentials outside the configured relay");
		}
		const inherited = new Headers(input instanceof Request ? input.headers : undefined);
		for (const [name, value] of new Headers(init?.headers)) inherited.set(name, value);
		const enforced = requestHeaders(profile, sessionId, apiKey, headers, Object.fromEntries(inherited));
		const outgoing = new Headers();
		for (const [name, value] of Object.entries(enforced)) {
			if (value !== null) outgoing.set(name, value);
		}
		const routed = url.toString() === originalUrl ? input
			: input instanceof Request ? new Request(url, input)
				: typeof input === "string" ? url.toString() : url;
		return transport(routed, { ...init, headers: outgoing, redirect: "error" });
	};
}

/**
 * Prepare a request for a native Pi delegate. Own session/key validation,
 * defaults, SDK-facing headers and final wire enforcement behind one seam.
 * Production and tests use the same injected fetch; nothing patches globals.
 */
export function prepareRelayRequest<TApi extends Api>(
	profile: RelayProfile<TApi>, model: Model<Api>, options?: StreamOptions,
): { model: Model<TApi>; options: StreamOptions & { sessionId: string } } {
	if (model.api !== profile.api) {
		throw new Error(`pi-chameleon ${profile.provider} transport requires ${profile.api}`);
	}
	const apiKey = options?.apiKey;
	if (apiKey === undefined || apiKey.trim().length === 0) {
		throw new Error(`No API key for provider: ${profile.provider}`);
	}
	const sessionId = sessionUuid(options?.sessionId);
	const baseUrl = model.baseUrl;
	checkedUrl(baseUrl);
	return {
		model: model as Model<TApi>,
		options: {
			...options,
			// Header-owned auth avoids native token-format/OAuth inference.
			apiKey: undefined,
			sessionId,
			headers: requestHeaders(profile, sessionId, apiKey, options?.headers),
			fetch: relayFetch(profile, baseUrl, apiKey, sessionId, options?.headers, options?.fetch ?? globalThis.fetch),
			timeoutMs: options?.timeoutMs ?? 600_000,
			maxRetries: options?.maxRetries ?? 0,
		},
	};
}
