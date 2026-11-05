import { release } from "node:os";
import type { RelayProfile } from "../relay-transport.ts";

/** Official rust-v0.166.0 profile; never copies credentials or machine ids. */
const VERSION = "0.166.0";
const ORIGINATOR = "codex_cli_rs";
export const CODEX_IDENTITY =
	"You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI.";

function hostPlatform(): string {
	if (process.platform === "win32") return "Windows";
	if (process.platform === "darwin") return "Mac OS";
	if (process.platform === "linux") return "Linux";
	return process.platform;
}

function hostArchitecture(): string {
	if (process.arch === "arm64") return "aarch64";
	if (process.arch === "x64") return "x86_64";
	return process.arch;
}

function terminalUserAgent(): string {
	const program = process.env.TERM_PROGRAM;
	if (program && !/tmux/i.test(program)) {
		const version = process.env.TERM_PROGRAM_VERSION;
		return version ? `${program}/${version}` : program;
	}
	if (process.env.WT_SESSION) return "WindowsTerminal";
	if (process.env.WEZTERM_EXECUTABLE) return "WezTerm";
	return process.env.TERM || "unknown";
}

function userAgent(): string {
	return `${ORIGINATOR}/${VERSION} (${hostPlatform()} ${release()}; ${hostArchitecture()}) ${terminalUserAgent()}`
		.replace(/[^\x20-\x7e]/g, "_");
}

/** Public API-key profile, not ChatGPT OAuth/backend-specific behavior. */
export const CODEX_PROFILE: RelayProfile<"openai-responses"> = {
	provider: "chameleon-codex",
	api: "openai-responses",
	auth: "bearer",
	omitHeader(name) {
		return name.startsWith("x-stainless-") || name.startsWith("anthropic-") ||
			name.startsWith("x-claude-") || name.startsWith("x-codex-") ||
			name.startsWith("x-openai-") || name === "openai-beta" ||
			name === "session_id" || name === "conversation_id" || name === "thread_id" ||
			name === "x-app" || name === "x-trace-id";
	},
	headers(sessionId) {
		return {
			accept: "text/event-stream",
			"accept-encoding": "identity",
			"content-type": "application/json",
			originator: ORIGINATOR,
			"user-agent": userAgent(),
			version: VERSION,
			"session-id": sessionId,
			"thread-id": sessionId,
			"x-client-request-id": sessionId,
		};
	},
};
