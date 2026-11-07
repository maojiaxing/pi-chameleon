import assert from "node:assert/strict";
import { Type } from "typebox";
import {
	normalizeContext, type FetchFunction, type Model, type TranscriptContext,
} from "@earendil-works/pi-ai";
// Fixed chat regression inputs are test-only. Discovery never uses this membership or capability data.
const CLAUDE_FIXTURE_COMPAT = {
	supportsMidConvoSystemMessages: true, supportsMidConvoEffort: false, supportsMidConvoToolChanges: false,
	supportsStrictTools: false, supportsEagerToolInputStreaming: false,
};
export const CLAUDE_FIXTURE_MODELS: Omit<Model<"anthropic-messages">, "api" | "provider" | "baseUrl">[] = [
	{
		type: "chat", id: "claude-opus-5-5", name: "Claude Opus 5.5 (chameleon)", reasoning: true, input: ["text", "image"],
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, contextWindow: 1_000_000, maxTokens: 128_000,
		compat: { forceAdaptiveThinking: true, supportsTemperature: false, ...CLAUDE_FIXTURE_COMPAT },
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	},
	{
		type: "chat", id: "claude-opus-4-6", name: "Claude Opus 4.6 (chameleon)", reasoning: true, input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, contextWindow: 1_000_000, maxTokens: 128_000,
		compat: { forceAdaptiveThinking: true, ...CLAUDE_FIXTURE_COMPAT }, thinkingLevelMap: { max: "max" },
	},
	{
		type: "chat", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (chameleon)", reasoning: true, input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, contextWindow: 1_000_000, maxTokens: 128_000,
		compat: { forceAdaptiveThinking: true, ...CLAUDE_FIXTURE_COMPAT }, thinkingLevelMap: { max: "max" },
	},
];
const CODEX_FIXTURE_THINKING = {
	off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null,
};
export const CODEX_FIXTURE_MODELS: Omit<Model<"openai-responses">, "api" | "provider" | "baseUrl">[] = [
	{
		type: "chat", id: "gpt-5.3-codex", name: "GPT-5.3 Codex (chameleon)", reasoning: true, input: ["text", "image"],
		cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 }, contextWindow: 400_000, maxTokens: 128_000,
		compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: true, supportsMidConvoSystemMessages: true },
		thinkingLevelMap: { ...CODEX_FIXTURE_THINKING },
	},
	{
		type: "chat", id: "gpt-5.4", name: "GPT-5.4 (chameleon)", reasoning: true, input: ["text", "image"],
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0,
			tiers: [{ inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }] },
		contextWindow: 272_000, maxTokens: 128_000,
		compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: true, supportsMidConvoSystemMessages: true },
		thinkingLevelMap: { ...CODEX_FIXTURE_THINKING },
	},
	{
		type: "chat", id: "gpt-5.5", name: "GPT-5.5 (chameleon)", reasoning: true, input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0,
			tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 0 }] },
		contextWindow: 272_000, maxTokens: 128_000,
		compat: { supportsStrictMode: true, supportsOpenAIGrammarTools: true, supportsMidConvoSystemMessages: true },
		thinkingLevelMap: { ...CODEX_FIXTURE_THINKING },
	},
];

export const API_KEY = "offline-test-key";
export const SESSION_ID = "11111111-2222-4333-8444-555555555555";
export const BASE_URL = "https://relay.example.com";
// Expected wire facts are deliberately independent from production constants.
export const CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
export const CODEX_IDENTITY = "You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI.";
export const CLAUDE_BETAS = [
	"claude-code-20250219", "context-1m-2025-08-07", "interleaved-thinking-2025-05-14",
	"thinking-token-count-2026-05-13", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05",
	"per-turn-control-2026-07-01", "mid-conversation-tool-changes-2026-07-01", "effort-2025-11-24",
	"thinking-display-updates-2026-08-18", "afk-mode-2026-01-31",
];

export function object(value: unknown): Record<string, unknown> {
	assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
	return value as Record<string, unknown>;
}
export function array(value: unknown): unknown[] {
	assert.ok(Array.isArray(value));
	return value;
}

export function claudeModel(id = "claude-opus-5-5"): Model<"anthropic-messages"> {
	const configured = CLAUDE_FIXTURE_MODELS.find((entry) => entry.id === id);
	assert.ok(configured);
	return { ...configured, api: "anthropic-messages", provider: "chameleon-claude", baseUrl: BASE_URL };
}
export function codexModel(id = "gpt-5.3-codex"): Model<"openai-responses"> {
	const configured = CODEX_FIXTURE_MODELS.find((entry) => entry.id === id);
	assert.ok(configured);
	return { ...configured, api: "openai-responses", provider: "chameleon-codex", baseUrl: `${BASE_URL}/v1` };
}
export function context(): TranscriptContext {
	return normalizeContext({
		systemPrompt: "You are a coding assistant running inside pi, a coding agent harness. Keep project rules.",
		tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
		messages: [
			{ role: "user", content: "Reply ok.", timestamp: 1 },
			{ role: "system", content: "# Environment\nActual Pi context, not copied from the capture.", timestamp: 2 },
		],
	});
}

export function sse(events: Record<string, unknown>[]): Response {
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200, headers: { "content-type": "text/event-stream", "x-test-response": "present" },
	});
}
export function claudeStart(): Record<string, unknown> {
	return {
		type: "message_start",
		message: {
			id: "msg_fixture", type: "message", role: "assistant", model: "claude-opus-5-5",
			content: [], stop_reason: null, stop_sequence: null,
			usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
		},
	};
}
export function claudeTextResponse(): Response {
	return sse([
		claudeStart(),
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
		{ type: "message_stop" },
	]);
}
export function codexTextResponse(): Response {
	return sse([
		{ type: "response.created", response: { id: "resp_fixture" } },
		{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_fixture", role: "assistant", status: "in_progress", content: [] } },
		{ type: "response.output_text.delta", output_index: 0, delta: "ok" },
		{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] } },
		{ type: "response.completed", response: {
			id: "resp_fixture", status: "completed", output: [],
			usage: { input_tokens: 12, output_tokens: 2, total_tokens: 14, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 1 } },
		} },
	]);
}

export interface CapturedRequest {
	url: string;
	headers: Headers;
	body: Record<string, unknown>;
	redirect: RequestRedirect;
}
export function capture(response: () => Response): { requests: CapturedRequest[]; fetch: FetchFunction } {
	const requests: CapturedRequest[] = [];
	const fetch: FetchFunction = async (input, init) => {
		const request = new Request(input, init);
		const text = await request.text();
		requests.push({ url: request.url, headers: request.headers, redirect: request.redirect, body: text ? object(JSON.parse(text)) : {} });
		return response();
	};
	return { requests, fetch };
}
