/** Register CLI behavior only. Pi owns models.json, credentials and overrides. */
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CLAUDE_MODELS } from "./claude/models.ts";
import { claudeCodeStream, claudeCodeStreamSimple } from "./claude/stream.ts";
import { CODEX_MODELS } from "./codex/models.ts";
import { codexStream, codexStreamSimple } from "./codex/stream.ts";

export default function chameleon(pi: ExtensionAPI): void {
	// Native providers sit below Pi's models.json overrides. The legacy form
	// replaces models after JSON composition and would defeat user additions.
	pi.registerProvider(createProvider({
		id: "chameleon-claude",
		name: "Chameleon Claude (Claude Code disguise)",
		auth: { apiKey: envApiKeyAuth("Relay API key", []) },
		models: CLAUDE_MODELS.map((model) => ({
			...model, provider: "chameleon-claude", api: "anthropic-messages" as const,
			// No guessed upstream: requests fail closed until Pi supplies baseUrl.
			baseUrl: "",
		})),
		api: { stream: claudeCodeStream, streamSimple: claudeCodeStreamSimple },
	}));
	pi.registerProvider(createProvider({
		id: "chameleon-codex",
		name: "Chameleon Codex (Codex CLI disguise)",
		auth: { apiKey: envApiKeyAuth("Relay API key", []) },
		models: CODEX_MODELS.map((model) => ({
			...model, provider: "chameleon-codex", api: "openai-responses" as const, baseUrl: "",
		})),
		api: { stream: codexStream, streamSimple: codexStreamSimple },
	}));
}
