import type { Model } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
type ChatModelConfig = Omit<Extract<ProviderModelConfig, { reasoning: boolean }>, "compat"> & {
	compat?: Model<"anthropic-messages">["compat"];
};

/**
 * Default model catalog. Metadata mirrors the pi-ai 1.5.0 built-in Anthropic
 * catalog (providers/data/anthropic.json) so costs, limits, and thinking
 * behavior match reality; `compat.forceAdaptiveThinking` makes the native
 * streamSimple map reasoning levels to `effort`. Users can override via
 * models.json as with any provider.
 */

export const CLAUDE_MODELS: ChatModelConfig[] = [
	{
		type: "chat",
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5 (chameleon)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		compat: {
			forceAdaptiveThinking: true,
			supportsTemperature: false,
			supportsMidConvoEffort: true,
			supportsMidConvoSystemMessages: true,
			supportsMidConvoToolChanges: true,
			supportsStrictTools: true,
		},
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		type: "chat",
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6 (chameleon)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
		thinkingLevelMap: { max: "max" },
	},
	{
		type: "chat",
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (chameleon)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
		thinkingLevelMap: { max: "max" },
	},
];
