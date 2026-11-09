import { DEVICE_ID } from "../identity.ts";
import type { RelayProfile } from "../relay-transport.ts";

/** The approved Claude Code request identity. */
const VERSION = "2.1.274";

/** Native serializer profile matching the user's actual Aether wire capture. */
export const CLAUDE_SERIALIZER_COMPAT = {
	supportsMidConvoSystemMessages: true,
	supportsMidConvoToolChanges: false,
	supportsStrictTools: false,
	supportsEagerToolInputStreaming: false,
} as const;

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
export const EPHEMERAL = { type: "ephemeral" } as const;
export const CONTEXT_MANAGEMENT = {
	edits: [{ type: "clear_thinking_20251015", keep: "all" }],
} as const;
export const THINKING = { type: "adaptive", display: "updates" } as const;

const CONTEXT_BETA = "context-1m-2025-08-07";

export function finalizeClaudePayload(payload: unknown, sessionId: string): unknown {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("Claude request metadata cannot be safely normalized");
	}
	const body = payload as Record<string, unknown>;
	const rawMetadata = body.metadata;
	if (rawMetadata !== undefined && (typeof rawMetadata !== "object" || rawMetadata === null || Array.isArray(rawMetadata))) {
		throw new Error("Claude request metadata cannot be safely normalized");
	}
	const metadata = (rawMetadata ?? {}) as Record<string, unknown>;
	let userId: Record<string, unknown> = {};
	if (metadata.user_id !== undefined) {
		try {
			const parsed = typeof metadata.user_id === "string" ? JSON.parse(metadata.user_id) : metadata.user_id;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
			userId = parsed as Record<string, unknown>;
		} catch {
			throw new Error("Claude request metadata.user_id cannot be safely normalized");
		}
	}
	return {
		...body,
		metadata: {
			...metadata,
			user_id: JSON.stringify({ ...userId, device_id: DEVICE_ID, account_uuid: "", session_id: sessionId }),
		},
	};
}

function appendMissingContextBeta(headers: Record<string, string | null>): void {
	const native = headers["anthropic-beta"];
	if (typeof native !== "string" || native.trim().length === 0) {
		headers["anthropic-beta"] = CONTEXT_BETA;
		return;
	}
	if (!native.split(",").some((feature) => feature.trim() === CONTEXT_BETA)) {
		headers["anthropic-beta"] = `${native},${CONTEXT_BETA}`;
	}
}

/** Only the Claude wire differences; shared transport owns credential safety. */
export const CLAUDE_PROFILE: RelayProfile<"anthropic-messages"> = {
	provider: "chameleon-claude",
	api: "anthropic-messages",
	auth: "x-api-key",
	protectedHeaders: ["anthropic-beta"],
	headers(sessionId) {
		return {
			"user-agent": `claude-cli/${VERSION} (external, cli)`,
			"x-app": "cli",
			"x-claude-code-session-id": sessionId,
		};
	},
	finalizeHeaders: appendMissingContextBeta,
	finalizeBody: finalizeClaudePayload,
};
