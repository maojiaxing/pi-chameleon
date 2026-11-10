import { isDeepStrictEqual } from "node:util";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { PreparedPayload } from "../request-lifecycle.ts";
import { finalizeClaudePayload } from "./identity.ts";
import { resolveClaudeCachePolicy, type ClaudeCachePolicy } from "./cache-policy.ts";
import { claudeCodePrompt } from "./prompts.ts";
import { wireToolNamesDeep } from "./tools.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function withoutCache(block: Record<string, unknown>): Record<string, unknown> {
	const { cache_control: _cache, ...rest } = block;
	return rest;
}

function cacheable(block: unknown): boolean {
	if (!isRecord(block)) return false;
	switch (block.type) {
		case "text": return typeof block.text === "string" && block.text.length > 0;
		case "image": return isRecord(block.source);
		case "tool_result": return typeof block.tool_use_id === "string" &&
			(typeof block.content === "string" ? block.content.length > 0 : Array.isArray(block.content) && block.content.length > 0);
		case "tool_addition":
		case "tool_removal": return isRecord(block.tool);
		default: return false;
	}
}

/**
 * The captured layout has cache breakpoints only on the two fixed system
 * blocks, final top-level tool, and final user content block. Schemas, tool
 * inputs and nested result data are opaque, never traversed for lookalike keys.
 */
function alignCacheBreakpoints(value: unknown, policy: ClaudeCachePolicy): unknown {
	if (!isRecord(value)) return value;
	const body = withoutCache(value);
	if (Array.isArray(value.system)) {
		body.system = value.system.map((block, index) => isRecord(block)
			? { ...withoutCache(block), ...(policy.control && index < 2 && cacheable(block) ? { cache_control: { ...policy.control } } : {}) }
			: block);
	}
	if (Array.isArray(value.tools)) {
		body.tools = value.tools.map((tool, index, all) => isRecord(tool)
			? { ...withoutCache(tool), ...(policy.control && policy.tools && index === all.length - 1 ? { cache_control: { ...policy.control } } : {}) }
			: tool);
	}
	if (Array.isArray(value.messages)) {
		const lastUser = value.messages.findLastIndex((message) => isRecord(message) && message.role === "user");
		body.messages = value.messages.map((message, index) => {
			if (!isRecord(message)) return message;
			let content = message.content;
			if (policy.control && typeof content === "string" && index === lastUser && content.length > 0) {
				content = [{ type: "text", text: content, cache_control: { ...policy.control } }];
			} else if (Array.isArray(content)) {
				const lastEligible = content.findLastIndex(cacheable);
				content = content.map((block, blockIndex) => isRecord(block)
					? { ...withoutCache(block), ...(policy.control && index === lastUser && blockIndex === lastEligible ? { cache_control: { ...policy.control } } : {}) }
					: block);
			}
			return { ...message, content };
		});
	}
	return body;
}

function compatiblePayload(payload: unknown, sessionId: string): { payload: unknown; fromWire: ReadonlyMap<string, string> } {
	if (!isRecord(payload)) return { payload, fromWire: new Map() };
	const { system, messages } = claudeCodePrompt(payload);
	const fromWire = new Map<string, string>();
	// Native serialization already emitted thinking, effort history, and ordinary tool schemas.
	// Do not reinterpret those fields after the SDK has selected their semantics.
	const wired = wireToolNamesDeep({
		...payload,
		system,
		messages,
		tools: payload.tools ?? [],
	}, fromWire);
	return { payload: finalizeClaudePayload(wired, sessionId), fromWire };
}

const NO_CACHE: ClaudeCachePolicy = { retention: "none", control: undefined, tools: false };

/** Freeze only protocol fields owned by compatibility; opaque data remains exact. */
function protectedView(payload: unknown): Record<string, unknown> {
	if (!isRecord(payload) || !Array.isArray(payload.messages)) throw new Error("Claude hook returned an invalid payload");
	return alignCacheBreakpoints(payload, NO_CACHE) as Record<string, unknown>;
}
function validateHook(before: Record<string, unknown>, after: unknown): void {
	const value = protectedView(after);
	for (const field of ["model", "system", "tools", "tool_choice", "permissions", "thinking", "output_config", "context_management"]) {
		if (!isDeepStrictEqual(value[field], before[field])) throw new Error("Claude hook changed a protected payload field");
	}
	const original = before.messages as unknown[];
	const messages = value.messages as unknown[];
	if (messages.length < original.length || !isDeepStrictEqual(messages.slice(0, original.length), original)) {
		throw new Error("Claude hook changed protected conversation content");
	}
	for (const message of messages.slice(original.length)) {
		if (!isRecord(message) || message.role !== "user" || Object.keys(message).some((key) => !["role", "content"].includes(key))) {
			throw new Error("Claude hook appended protected conversation content");
		}
		if (typeof message.content === "string") continue;
		if (!Array.isArray(message.content) || message.content.some((block) => !isRecord(block) ||
			(block.type !== "text" && block.type !== "image") ||
			Object.keys(block).some((key) => !(block.type === "text" ? ["type", "text"] : ["type", "source"]).includes(key)))) {
			throw new Error("Claude hook appended protected protocol content");
		}
	}
}

/** Per-request wire adaptation and tool-name restoration state, not session state. */
export function claudePayloadAdapter(sessionId: string, policy?: ClaudeCachePolicy) {
	let names: ReadonlyMap<string, string> = new Map();
	return {
		fromWire: () => names,
		prepare(payload: unknown, model: Model<Api>, hasHook: boolean): PreparedPayload {
			const nativeParams = payload as Record<string, unknown>;
			const betas = Array.isArray(nativeParams?.betas) ? [...nativeParams.betas] : undefined;
			const adapted = compatiblePayload(payload, sessionId);
			names = adapted.fromWire;
			const effective = policy ?? resolveClaudeCachePolicy({}, model);
			const prepared = alignCacheBreakpoints(adapted.payload, effective);
			const snapshot = hasHook ? structuredClone(protectedView(prepared)) : undefined;
			return {
				value: prepared,
				finish(candidate) {
					if (snapshot) validateHook(snapshot, candidate);
					const result = finalizeClaudePayload(alignCacheBreakpoints(candidate, effective), sessionId);
					if (!isRecord(result)) return result;
					const protectedPayload = { ...result };
					if (betas === undefined) delete protectedPayload.betas;
					else protectedPayload.betas = betas;
					return protectedPayload;
				},
			};
		},
	};
}
