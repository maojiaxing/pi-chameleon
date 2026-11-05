import { randomUUID } from "node:crypto";
import type { RelayProfile } from "../relay-transport.ts";

/** Fixed Claude Code 2.1.302 capture. Versioned wire facts live together. */
const VERSION = "2.1.302";
const BETAS = [
	"claude-code-20250219",
	"context-1m-2025-08-07",
	"interleaved-thinking-2025-05-14",
	"thinking-token-count-2026-05-13",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"per-turn-control-2026-07-01",
	"mid-conversation-tool-changes-2026-07-01",
	"effort-2025-11-24",
	"thinking-display-updates-2026-08-18",
	"afk-mode-2026-01-31",
] as const;

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
export const EPHEMERAL = { type: "ephemeral" } as const;
export const CONTEXT_MANAGEMENT = {
	edits: [{ type: "clear_thinking_20251015", keep: "all" }],
} as const;
export const THINKING = { type: "adaptive", display: "updates" } as const;

/** Only the Claude wire differences; shared transport owns credential safety. */
export const CLAUDE_PROFILE: RelayProfile<"anthropic-messages"> = {
	provider: "chameleon-claude",
	api: "anthropic-messages",
	auth: "x-api-key",
	rewriteUrl(url) {
		if (url.pathname.endsWith("/v1/messages")) url.searchParams.set("beta", "true");
	},
	headers(sessionId) {
		return {
			accept: "text/event-stream",
			"accept-encoding": "identity",
			"anthropic-beta": BETAS.join(","),
			"anthropic-dangerous-direct-browser-access": "true",
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
			"user-agent": `claude-cli/${VERSION} (external, cli)`,
			"x-app": "cli",
			"x-stainless-arch": "x64",
			"x-stainless-lang": "js",
			"x-stainless-os": "Windows",
			"x-stainless-package-version": "0.128.0",
			"x-stainless-retry-count": "0",
			"x-stainless-runtime": "node",
			"x-stainless-runtime-version": "v26.3.0",
			"x-stainless-timeout": "60000",
			"x-claude-code-session-id": sessionId,
			"x-trace-id": randomUUID(),
		};
	},
};
