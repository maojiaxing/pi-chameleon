import type { Api, FetchFunction, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { CatalogRecord, DiscoveryAccess, DiscoveryClock, RelayFamily } from "./types.ts";

interface CatalogFetchOptions {
	fetch: FetchFunction;
	signal?: AbortSignal;
	clock?: DiscoveryClock;
	budgetMs?: number;
}

type CatalogErrorCode = "invalid-response" | "conflicting-model" | "invalid-pagination" | "unsafe-url" | "invalid-auth" | "network-error" | "unsafe-response" | "http-error" | "timeout" | "cancelled";

/** Safe error facts for lifecycle policy. Never attach an upstream cause/body/URL. */
export class CatalogFetchError extends Error {
	readonly code: CatalogErrorCode;
	readonly httpStatus?: number;
	constructor(code: CatalogErrorCode, httpStatus?: number) {
		super(`Model discovery failed (${code})`);
		this.name = "CatalogFetchError";
		this.code = code;
		this.httpStatus = httpStatus;
	}
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

// Compare complete JSON items in memory for conflict detection; never persist raw data.
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

const CREDENTIAL_HEADERS = new Set([
	"authorization", "x-api-key", "api-key", "proxy-authorization", "cookie", "cookie2",
	"cf-aig-authorization", "chatgpt-account-id", "x-openai-actor-authorization",
]);

function checkedUrl(value: string): URL {
	let url: URL;
	try { url = new URL(value); } catch { throw new CatalogFetchError("unsafe-url"); }
	if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new CatalogFetchError("unsafe-url");
	}
	return url;
}

function discoveryHeaders(family: RelayFamily, access: DiscoveryAccess): Headers {
	if (typeof access.apiKey !== "string" || !access.apiKey.trim() || /[\u0000-\u001f\u007f]/.test(access.apiKey)) {
		throw new CatalogFetchError("invalid-auth");
	}
	const headers = new Headers();
	for (const [name, value] of Object.entries(access.headers ?? {})) {
		if (value !== null) headers.set(name, value);
		else headers.delete(name);
	}
	const bearer = family === "codex" || headers.get("authorization") === `Bearer ${access.apiKey}`;
	for (const name of [...headers.keys()]) {
		if (CREDENTIAL_HEADERS.has(name) || /^(?:user-agent|originator|session[_-]id|anthropic-beta)$/.test(name)
			|| /^x-(?:stainless|claude|codex|session|client)/.test(name)) headers.delete(name);
	}
	headers.set(bearer ? "authorization" : "x-api-key", bearer ? `Bearer ${access.apiKey}` : access.apiKey!);
	headers.set("accept", "application/json");
	if (family === "claude") headers.set("anthropic-version", "2026-10-21");
	return headers;
}

function positiveLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function support(value: unknown): boolean | undefined {
	return object(value) && typeof value.supported === "boolean" ? value.supported : undefined;
}

function catalogRecord(family: RelayFamily, item: Record<string, unknown> & { id: string }): CatalogRecord {
	const record: CatalogRecord = { id: item.id };
	if (family !== "claude") return record;
	if (validId(item.display_name)) record.name = item.display_name;
	// Anthropic documents this as the maximum input context window, not a sum of limits.
	if (positiveLimit(item.max_input_tokens)) record.contextWindow = item.max_input_tokens;
	if (positiveLimit(item.max_tokens)) record.maxTokens = item.max_tokens;
	if (!object(item.capabilities)) return record;
	const image = support(item.capabilities.image_input);
	if (image !== undefined) record.input = image ? ["text", "image"] : ["text"];
	const thinking = support(item.capabilities.thinking);
	if (thinking !== undefined) record.reasoning = thinking;
	const thinkingFacts = item.capabilities.thinking;
	const adaptive = object(thinkingFacts) && object(thinkingFacts.types) ? support(thinkingFacts.types.adaptive) : undefined;
	if (thinking === false || adaptive !== undefined) record.compat = { forceAdaptiveThinking: thinking !== false && adaptive === true };
	return record;
}

function isCandidate(family: RelayFamily, id: string): boolean {
	if (id.includes("/")) return false;
	const belongs = family === "claude" ? /^claude-.+/i.test(id) : /^(?:(?:gpt|chatgpt|codex)-.+|o\d+(?:-.+)?)$/i.test(id);
	return belongs && !/(?:^|[-_.])(?:image|audio|realtime|embedding|embeddings|tts|transcribe|transcription|speech)(?:$|[-_.])/i.test(id);
}

async function responseBody(url: URL, headers: Headers, options: CatalogFetchOptions): Promise<unknown> {
	let response: Response;
	try {
		response = await awaitPromise(() => options.fetch(url, { method: "GET", headers, signal: options.signal, redirect: "error", credentials: "omit" }), options.signal!);
	} catch { throw new CatalogFetchError("network-error"); }
	// An empty URL is permitted by synthetic Response objects; a transport-reported URL must be exact, including after_id.
	if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url.href)) {
		throw new CatalogFetchError("unsafe-response");
	}
	if (!response.ok) throw new CatalogFetchError("http-error", response.status);
	try { return await awaitPromise(() => response.json(), options.signal!); } catch { throw new CatalogFetchError("invalid-response"); }
}

function cancellation(signal: AbortSignal): CatalogFetchError {
	return signal.reason instanceof CatalogFetchError ? signal.reason : new CatalogFetchError("cancelled");
}

function awaitPromise<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => { cleanup(); reject(cancellation(signal)); };
		signal.addEventListener("abort", onAbort, { once: true });
		// Always attach both handlers, including when an ignored-signal operation settles late.
		Promise.resolve().then(() => {
			if (signal.aborted) throw cancellation(signal);
			return operation();
		}).then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
		if (signal.aborted) onAbort();
	});
}

const SYSTEM_CLOCK: DiscoveryClock = {
	now: () => Date.now(),
	setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
	clearTimeout: (handle) => clearTimeout(handle),
};

/** One complete catalog operation owns one network budget and never publishes partial data. */
export async function fetchCatalog(
	family: RelayFamily, access: DiscoveryAccess, options: CatalogFetchOptions,
): Promise<readonly CatalogRecord[]> {
	if (options.signal?.aborted) throw new CatalogFetchError("cancelled");
	const clock = options.clock ?? SYSTEM_CLOCK;
	const budget = options.budgetMs ?? 15_000;
	if (!Number.isFinite(budget) || budget <= 0) throw new CatalogFetchError("timeout");
	const deadline = clock.now() + budget;
	const controller = new AbortController();
	const cancel = () => controller.abort(new CatalogFetchError("cancelled"));
	options.signal?.addEventListener("abort", cancel, { once: true });
	const timer = clock.setTimeout(() => controller.abort(new CatalogFetchError("timeout")), budget);
	try {
		const records = await collectCatalog(family, access, { ...options, signal: controller.signal });
		if (!controller.signal.aborted && clock.now() >= deadline) controller.abort(new CatalogFetchError("timeout"));
		if (controller.signal.aborted) throw cancellation(controller.signal);
		return records;
	} catch (error) {
		if (controller.signal.aborted) throw cancellation(controller.signal);
		if (error instanceof CatalogFetchError) throw error;
		throw new CatalogFetchError("invalid-response");
	} finally {
		clock.clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
	}
}

/** Obtain catalog membership, never a chat-protocol availability guarantee. */
async function collectCatalog(
	family: RelayFamily, access: DiscoveryAccess, options: CatalogFetchOptions,
): Promise<readonly CatalogRecord[]> {
	const url = checkedUrl(access.baseUrl);
	url.pathname = `${url.pathname.replace(/\/+$/, "")}${family === "claude" ? "/v1/models" : "/models"}`;
	let headers: Headers;
	try { headers = discoveryHeaders(family, access); } catch { throw new CatalogFetchError("invalid-auth"); }
	const records = new Map<string, CatalogRecord>();
	const seen = new Map<string, string>();
	const cursors = new Set<string>();
	let more: boolean;
	do {
		const body = await responseBody(url, headers, options);
		if (!object(body) || !Array.isArray(body.data)) throw new CatalogFetchError("invalid-response");
		for (const item of body.data) {
			if (!object(item) || !validId(item.id)) throw new CatalogFetchError("invalid-response");
			const signature = canonical(item);
			const previous = seen.get(item.id);
			if (previous !== undefined && previous !== signature) throw new CatalogFetchError("conflicting-model");
			seen.set(item.id, signature);
			if (isCandidate(family, item.id)) records.set(item.id, catalogRecord(family, { ...item, id: item.id }));
		}
		more = false;
		if (family === "claude") {
			if (typeof body.has_more !== "boolean") throw new CatalogFetchError("invalid-pagination");
			const first = body.data[0]?.id;
			const last = body.data.at(-1)?.id;
			for (const [key, expected] of [["first_id", first], ["last_id", last]] as const) {
				if (body[key] !== undefined && body[key] !== null && body[key] !== expected) {
					throw new CatalogFetchError("invalid-pagination");
				}
			}
			more = body.has_more;
			if (more) {
				if (!validId(body.last_id) || body.last_id !== last || cursors.has(body.last_id)) {
					throw new CatalogFetchError("invalid-pagination");
				}
				cursors.add(body.last_id);
				url.searchParams.set("after_id", body.last_id);
			}
		}
	} while (more);
	return [...records.values()];
}

const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function validRate(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function modelCost(apiCost: CatalogRecord["cost"], referenceCost: CatalogRecord["cost"]): {
	cost: Model<Api>["cost"]; source: "reference" | "unknown" | "api";
} {
	const cost: Model<Api>["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let unknown = false;
	let reference = false;
	for (const key of RATE_FIELDS) {
		if (validRate(apiCost?.[key])) cost[key] = apiCost[key];
		else if (validRate(referenceCost?.[key])) { cost[key] = referenceCost[key]; reference = true; }
		else unknown = true;
	}
	// Pricing tiers are capability facts; regenerate their numeric allowlist, not arbitrary objects.
	const tiers = apiCost?.tiers ?? referenceCost?.tiers;
	if (tiers?.length) {
		cost.tiers = tiers.filter((tier) => validRate(tier.inputTokensAbove) && RATE_FIELDS.every((key) => validRate(tier[key])))
			.map((tier) => ({ inputTokensAbove: tier.inputTokensAbove, input: tier.input, output: tier.output, cacheRead: tier.cacheRead, cacheWrite: tier.cacheWrite }));
		if (!apiCost?.tiers && cost.tiers.length) reference = true;
	}
	return { cost, source: unknown ? "unknown" : reference ? "reference" : "api" };
}

function modelCompat(family: RelayFamily, reference: CatalogRecord["compat"], facts: CatalogRecord["compat"]): CatalogRecord["compat"] {
	const allowed = family === "claude"
		? ["supportsEagerToolInputStreaming", "supportsLongCacheRetention", "supportsCacheControlOnTools", "supportsTemperature", "forceAdaptiveThinking", "allowEmptySignature", "supportsStrictTools", "supportsMidConvoEffort", "supportsMidConvoSystemMessages", "supportsMidConvoToolChanges"]
		: ["supportsDeveloperRole", "supportsMidConvoSystemMessages", "supportsLongCacheRetention", "supportsStrictMode", "supportsOpenAIGrammarTools", "supportsAdditionalTools", "supportsToolSearch", "supportsExplicitPromptCacheMode", "supportsMidConvoEffort", "supportsMaxOutputTokens"];
	const compat: Record<string, boolean> = {};
	for (const source of [reference, facts]) {
		if (!object(source)) continue;
		for (const [key, value] of Object.entries(source)) if (allowed.includes(key) && typeof value === "boolean") compat[key] = value;
	}
	return Object.keys(compat).length ? compat : undefined;
}

function modelThinking(reference: CatalogRecord["thinkingLevelMap"], facts: CatalogRecord["thinkingLevelMap"]): CatalogRecord["thinkingLevelMap"] {
	const map: NonNullable<CatalogRecord["thinkingLevelMap"]> = {};
	for (const source of [reference, facts]) {
		if (!object(source)) continue;
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			const effort = source[level];
			if (effort === null || (typeof effort === "string" && /^[a-z0-9_-]{1,64}$/i.test(effort))) map[level] = effort;
		}
	}
	return Object.keys(map).length ? map : undefined;
}

/** Pi composes user models and overrides above these discovery facts. */
export function buildModels(
	family: RelayFamily, accessBaseUrl: string, records: readonly CatalogRecord[],
): readonly Model<Api>[] {
	const api = family === "claude" ? "anthropic-messages" : "openai-responses";
	const builtin: readonly Model<Api>[] = getBuiltinModels(family === "claude" ? "anthropic" : "openai");
	return records.map((record) => {
		const reference = builtin.find((model) => model.id === record.id && model.api === api);
		const contextWindow = record.contextWindow ?? reference?.contextWindow ?? 32_768;
		const maxTokens = Math.min(record.maxTokens ?? reference?.maxTokens ?? 4_096, contextWindow);
		const input = record.input ?? reference?.input;
		const reasoning = record.reasoning ?? reference?.reasoning;
		const unknown = (record.contextWindow ?? reference?.contextWindow) === undefined
			|| (record.maxTokens ?? reference?.maxTokens) === undefined || input === undefined || reasoning === undefined;
		const { cost, source } = modelCost(record.cost, reference?.cost);
		const compat = modelCompat(family, reference?.compat, record.compat);
		const thinkingLevelMap = modelThinking(reference?.thinkingLevelMap, record.thinkingLevelMap);
		const labels = [unknown ? "能力未确认" : "", source === "reference" ? "参考费用" : source === "unknown" ? "费用未知，不代表免费" : ""].filter(Boolean);
		return {
			id: record.id,
			name: `${record.name ?? reference?.name ?? record.id}${labels.length ? `（${labels.join("；")}）` : ""}`,
			api,
			provider: `chameleon-${family}`,
			baseUrl: accessBaseUrl,
			contextWindow,
			maxTokens,
			input: input ? [...input] : ["text"],
			reasoning: reasoning ?? false,
			cost,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			...(compat ? { compat } : {}),
		};
	});
}
