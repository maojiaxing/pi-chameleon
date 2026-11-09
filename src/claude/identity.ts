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
};
