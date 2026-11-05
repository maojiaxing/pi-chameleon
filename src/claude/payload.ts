import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { CONTEXT_MANAGEMENT, EPHEMERAL, THINKING } from "./identity.ts";
import { DEVICE_ID } from "../identity.ts";
import { claudeCodeSystem } from "./prompts.ts";
import { wireToolNamesDeep } from "./tools.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Attach per-turn effort to a real system update when one is available. */
function mergeEffortMessages(messages: unknown): unknown {
	if (!Array.isArray(messages)) return messages;
	const merged: unknown[] = [];
	for (const message of messages) {
		const previous = merged[merged.length - 1];
		if (
			isRecord(message) && message.role === "system" &&
			Array.isArray(message.content) && message.content.length === 0 &&
			isRecord(message.output_config) &&
			Object.keys(message).every((key) => ["role", "content", "output_config"].includes(key)) &&
			isRecord(previous) && previous.role === "system" &&
			Array.isArray(previous.content) && previous.content.length > 0 &&
			previous.output_config === undefined
		) {
			merged[merged.length - 1] = { ...previous, output_config: message.output_config };
		} else {
			merged.push(message);
		}
	}
	return merged;
}

/**
 * Keep the real Pi conversation and tools. Assemble the CLI identity and
 * the captured core template with Pi's full runtime instructions. Replace
 * only the leading Pi identity and match the captured thinking and
 * effort fields. Environment text and command history are never fabricated.
 */
function compatiblePayload(
	payload: unknown,
	sessionId: string,
): { payload: unknown; fromWire: ReadonlyMap<string, string> } {
	if (!isRecord(payload)) return { payload, fromWire: new Map() };
	const source = payload;
	const system = claudeCodeSystem(source.system);
	const mergedMessages = mergeEffortMessages(source.messages);
	const messages = Array.isArray(mergedMessages)
		? mergedMessages.map((message, index, all) => {
				if (index !== all.length - 1 || !isRecord(message)) return message;
				const content = message.content;
				if (!Array.isArray(content) || content.length === 0) return message;
				return {
					...message,
					content: content.map((block, blockIndex) =>
						blockIndex === content.length - 1 && isRecord(block) && block.type === "text"
							? { ...block, cache_control: EPHEMERAL }
							: block,
					),
				};
			})
		: mergedMessages;

	let thinking = source.thinking;
	let outputConfig = source.output_config;
	if (isRecord(thinking) && thinking.type === "adaptive") {
		// Native pi adds binding controls; the captured beta profile does not.
		const { block_binding: _binding, ...adaptive } = thinking;
		thinking = { ...adaptive, ...THINKING };
		if (Array.isArray(messages)) {
			const lastEffort = [...messages].reverse().find((message) =>
				isRecord(message) && message.role === "system" &&
				isRecord(message.output_config) && typeof message.output_config.effort === "string",
			);
			if (isRecord(lastEffort) && isRecord(lastEffort.output_config)) {
				outputConfig = {
					...(isRecord(outputConfig) ? outputConfig : {}),
					effort: lastEffort.output_config.effort,
				};
			}
		}
	}

	const tools = Array.isArray(source.tools)
		? source.tools.map((tool, index, all) =>
				index === all.length - 1 && isRecord(tool)
					? { ...tool, cache_control: EPHEMERAL }
					: tool,
			)
		: source.tools;
	const fromWire = new Map<string, string>();
	const wired = wireToolNamesDeep(
		{
			...source,
			system,
			messages,
			tools,
			...(thinking !== undefined ? { thinking } : {}),
			...(outputConfig !== undefined ? { output_config: outputConfig } : {}),
		},
		fromWire,
	);
	return {
		payload: {
			...(wired as Record<string, unknown>),
			metadata: {
				...(isRecord(source.metadata) ? source.metadata : {}),
				user_id: JSON.stringify({
					device_id: DEVICE_ID,
					account_uuid: "",
					session_id: sessionId,
				}),
			},
			context_management: CONTEXT_MANAGEMENT,
		},
		fromWire,
	};
}

/**
 * One request's payload lifecycle. The reverse tool map remains local to the
 * Claude adapter and is available to its response stream, not shared transport.
 */
export function claudePayloadAdapter(sessionId: string, hook?: SimpleStreamOptions["onPayload"]) {
	let names: ReadonlyMap<string, string> = new Map();
	return {
		fromWire: () => names,
		async onPayload(payload: unknown, model: Model<Api>): Promise<unknown> {
			const adapted = compatiblePayload(payload, sessionId);
			names = adapted.fromWire;
			return (await hook?.(adapted.payload, model)) ?? adapted.payload;
		},
	};
}
