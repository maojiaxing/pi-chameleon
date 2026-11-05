import assert from "node:assert/strict";
import { Type } from "typebox";
import {
	normalizeContext, type FetchFunction, type Model, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { CLAUDE_MODELS } from "../src/claude/models.ts";
import { CODEX_MODELS } from "../src/codex/models.ts";

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
	const configured = CLAUDE_MODELS.find((entry) => entry.id === id);
	assert.ok(configured);
	return { ...configured, api: "anthropic-messages", provider: "chameleon-claude", baseUrl: BASE_URL };
}
export function codexModel(id = "gpt-5.3-codex"): Model<"openai-responses"> {
	const configured = CODEX_MODELS.find((entry) => entry.id === id);
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
		requests.push({ url: request.url, headers: request.headers, redirect: request.redirect, body: object(JSON.parse(await request.text())) });
		return response();
	};
	return { requests, fetch };
}
