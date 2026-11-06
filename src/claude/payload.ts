import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { CONTEXT_MANAGEMENT, EPHEMERAL, THINKING } from "./identity.ts";
import { DEVICE_ID } from "../identity.ts";
import { claudeCodePrompt } from "./prompts.ts";
import { wireToolNamesDeep } from "./tools.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function withoutCache(block: Record<string, unknown>): Record<string, unknown> {
	const { cache_control: _cache, ...rest } = block;
	return rest;
}

/**
 * The captured layout has cache breakpoints only on the two fixed system
 * blocks, final top-level tool, and final user content block. Schemas, tool
 * inputs and nested result data are opaque, never traversed for lookalike keys.
 */
function alignCacheBreakpoints(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const body = { ...value };
	if (Array.isArray(value.system)) {
		body.system = value.system.map((block, index) => isRecord(block)
			? { ...withoutCache(block), ...(index < 2 ? { cache_control: EPHEMERAL } : {}) }
			: block);
	}
	if (Array.isArray(value.tools)) {
		body.tools = value.tools.map((tool, index, all) => isRecord(tool)
			? { ...withoutCache(tool), ...(index === all.length - 1 ? { cache_control: EPHEMERAL } : {}) }
			: tool);
	}
	if (Array.isArray(value.messages)) {
		const lastUser = value.messages.findLastIndex((message) => isRecord(message) && message.role === "user");
		body.messages = value.messages.map((message, index) => {
			if (!isRecord(message)) return message;
			let content = message.content;
			if (typeof content === "string" && index === lastUser && content.length > 0) {
				content = [{ type: "text", text: content, cache_control: EPHEMERAL }];
			} else if (Array.isArray(content)) {
				content = content.map((block, blockIndex, all) => isRecord(block)
					? { ...withoutCache(block), ...(index === lastUser && blockIndex === all.length - 1 ? { cache_control: EPHEMERAL } : {}) }
					: block);
			}
			return { ...message, content };
		});
	}
	return body;
}

/** Current effort lives at top-level; strip only old effort-only system markers. */
function removePerTurnEffort(messages: unknown[]): unknown[] {
	return messages.flatMap((message) => {
		if (!isRecord(message) || message.role !== "system" || !isRecord(message.output_config) ||
			!Object.hasOwn(message.output_config, "effort")) return [message];
		const { effort: _effort, ...outputConfig } = message.output_config;
		const { output_config: _outputConfig, ...rest } = message;
		if (Object.keys(outputConfig).length > 0) return [{ ...rest, output_config: outputConfig }];
		if (Array.isArray(rest.content) && rest.content.length === 0 &&
			Object.keys(rest).every((key) => key === "role" || key === "content")) return [];
		return [rest];
	});
}

function compatiblePayload(payload: unknown, sessionId: string): { payload: unknown; fromWire: ReadonlyMap<string, string> } {
	if (!isRecord(payload)) return { payload, fromWire: new Map() };
	const { system, messages } = claudeCodePrompt(payload);
	let thinking = payload.thinking;
	if (isRecord(thinking) && thinking.type === "adaptive") {
		const { block_binding: _binding, ...adaptive } = thinking;
		thinking = { ...adaptive, ...THINKING };
	}
	const fromWire = new Map<string, string>();
	// Native serialization already emitted ordinary tool schemas. Do not try
	// to strip strict flags/nulls afterward: a require-strict tool must error.
	const wired = wireToolNamesDeep({
		...payload,
		system,
		messages: removePerTurnEffort(messages),
		tools: payload.tools ?? [],
		...(thinking !== undefined ? { thinking } : {}),
	}, fromWire);
	return {
		payload: {
			...(wired as Record<string, unknown>),
			metadata: {
				...(isRecord(payload.metadata) ? payload.metadata : {}),
				user_id: JSON.stringify({ device_id: DEVICE_ID, account_uuid: "", session_id: sessionId }),
			},
			context_management: CONTEXT_MANAGEMENT,
		},
		fromWire,
	};
}

/** Per-request wire adaptation and tool-name restoration state, not session state. */
export function claudePayloadAdapter(sessionId: string, hook?: SimpleStreamOptions["onPayload"]) {
	let names: ReadonlyMap<string, string> = new Map();
	return {
		fromWire: () => names,
		async onPayload(payload: unknown, model: Model<Api>): Promise<unknown> {
			const adapted = compatiblePayload(payload, sessionId);
			names = adapted.fromWire;
			const prepared = alignCacheBreakpoints(adapted.payload);
			return alignCacheBreakpoints((await hook?.(prepared, model)) ?? prepared);
		},
	};
}
