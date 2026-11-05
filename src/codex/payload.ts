import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { CODEX_IDENTITY } from "./identity.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only replace the leading Pi identity, never text in rules or examples. */
function runtimeInstructions(text: string): string {
	return text.replace(
		/^You are (?:an AI assistant|a coding assistant) running (?:inside|in) pi, a coding agent harness\.[ \t]*(?:\r?\n)?/,
		"",
	);
}

/** Compose an idempotent CLI identity while retaining the real Pi rules. */
function baseInstructions(text: string): string {
	if (text === CODEX_IDENTITY || text.startsWith(`${CODEX_IDENTITY}\n\n`)) return text;
	const runtime = runtimeInstructions(text);
	return runtime ? `${CODEX_IDENTITY}\n\n${runtime}` : CODEX_IDENTITY;
}

function optional(source: Record<string, unknown>, key: string): Record<string, unknown> {
	return source[key] === undefined ? {} : { [key]: source[key] };
}

/**
 * Native pi-ai already converts the real transcript, images, reasoning, and
 * tool schemas. Adapt only the leading instruction item and public CLI
 * request fields. Current Codex puts base instructions in developer input,
 * not top-level instructions; legacy instructions are migrated, not lost.
 * Arbitrary later system updates, user/tool data, names and schemas stay put.
 */
function codexPayload(payload: unknown): Record<string, unknown> {
	if (!isRecord(payload)) throw new Error("Codex Responses payload must be an object");
	if (!Array.isArray(payload.input)) throw new Error("Codex Responses input must be an array");
	const input = [...payload.input];
	const legacy = payload.instructions;
	if (legacy !== undefined && typeof legacy !== "string") {
		throw new Error("Codex instructions must be text");
	}
	const first = input[0];
	if (typeof legacy === "string" && legacy.length > 0) {
		input.unshift({ role: "developer", content: baseInstructions(legacy) });
	} else if (isRecord(first) && (first.role === "system" || first.role === "developer") && typeof first.content === "string") {
		input[0] = { ...first, role: "developer", content: baseInstructions(first.content) };
	} else {
		input.unshift({ role: "developer", content: CODEX_IDENTITY });
	}
	const include = Array.isArray(payload.include) ? [...payload.include] : [];
	if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
	// Routing fields first, as in the pinned Rust ResponsesApiRequest struct.
	// max_output_tokens is not a CLI default, but explicit Pi caps are valid
	// Responses API fields and must not silently disappear.
	return {
		model: payload.model,
		stream: true,
		...optional(payload, "service_tier"),
		input,
		...optional(payload, "tools"),
		tool_choice: payload.tool_choice ?? "auto",
		parallel_tool_calls: payload.parallel_tool_calls ?? true,
		reasoning: payload.reasoning ?? null,
		store: false,
		include,
		...optional(payload, "prompt_cache_key"),
		...optional(payload, "text"),
		...optional(payload, "max_output_tokens"),
	};
}

/** Keep all body policy, including explicit output caps and caller hooks, here. */
export function codexPayloadAdapter(options?: SimpleStreamOptions): NonNullable<SimpleStreamOptions["onPayload"]> {
	return async (payload: unknown, model: Model<Api>): Promise<unknown> => {
		const body = codexPayload(payload);
		// The native delegate invents a default cap from model.maxTokens;
		// Codex omits it unless Pi or the model explicitly requested one.
		if (options?.maxTokens === undefined &&
			options?.samplingParams?.max_output_tokens === undefined &&
			model.samplingParams?.max_output_tokens === undefined) {
			delete body.max_output_tokens;
		}
		return (await options?.onPayload?.(body, model)) ?? body;
	};
}
