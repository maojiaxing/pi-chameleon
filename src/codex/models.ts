import type { Model } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
type ChatModelConfig = Omit<Extract<ProviderModelConfig, { reasoning: boolean }>, "compat"> & {
	compat?: Model<"openai-responses">["compat"];
};

/** Metadata from the pinned pi-ai 1.5.0 OpenAI catalog, not relay discovery. */
const REASONING_MAP = {
	off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null,
};

export const CODEX_MODELS: ChatModelConfig[] = [
	{
		type: "chat",
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex (chameleon)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
		compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: true, supportsMidConvoSystemMessages: true },
		thinkingLevelMap: { ...REASONING_MAP },
	},
	{
		type: "chat",
		id: "gpt-5.4",
		name: "GPT-5.4 (chameleon)",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0,
			tiers: [{ inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }],
		},
		contextWindow: 272_000,
		maxTokens: 128_000,
		compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: true, supportsMidConvoSystemMessages: true },
		thinkingLevelMap: { ...REASONING_MAP },
	},
	{
		type: "chat",
		id: "gpt-5.5",
		name: "GPT-5.5 (chameleon)",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0,
			tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 }],
		},
		contextWindow: 272_000,
		maxTokens: 128_000,
		compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: true, supportsMidConvoSystemMessages: true },
		thinkingLevelMap: { ...REASONING_MAP },
	},
];
