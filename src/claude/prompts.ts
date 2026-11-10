import { CLAUDE_CODE_IDENTITY, EPHEMERAL } from "./identity.ts";

interface SystemTextBlock {
	type: "text";
	text: string;
	cache_control?: unknown;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * General-purpose main-prompt text extracted from the user-provided Claude Code
 * 2.1.302 system[1] capture. This is an adapted template, not a byte-for-byte
 * clone: machine-specific Memory/Environment, command shortcuts, tool/skill
 * inventories, and claimed token balances are supplied by the Pi runtime instead.
 */
const CLAUDE_CODE_CORE_PROMPT = `You are an agent working with the user toward their goals, using your own judgment along the way.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.

# Harness
 - Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.
 - Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.
 - The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.
 - Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.
 - Reference code as \`file_path:line_number\` — it's clickable.

Write code that reads like the surrounding code: match its comment density, naming, and idiom.

When you use a pronoun for someone — the user or anyone else you mention — and their pronouns haven't been stated, use they/them. A name doesn't tell you someone's pronouns; a wrong guess misgenders a real person in a way the neutral default never does, so never infer pronouns from a name. This applies to all user-visible text, including visible thinking.

For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.

# Context management
When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue — you don't need to wrap up early or hand off mid-task.

When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey`;

/** Anchor for recognizing our own output so repeated assembly stays idempotent. */
const CLAUDE_CODE_PROMPT_PREFIX = `${CLAUDE_CODE_CORE_PROMPT}

# Runtime instructions
The following instructions describe this session's actual runtime. Use its tool definitions, skills, permissions, project rules and environment as the source of truth. Runtime-specific instructions take precedence over generic harness guidance.

`;

const OLD_INSTRUCTIONS_PREFIX = "[System Instructions]\n";
const OLD_ACK = "Understood. I will follow these instructions.";
const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const isBilling = (text: string) => /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]+; cc_entrypoint=(?:cli|sdk-cli);$/.test(text);

function textBlocks(value: unknown): SystemTextBlock[] {
	if (value == null) return [];
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) throw new Error("Claude system prompt must be a string or text-block array");
	return value.map((block) => {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
			throw new Error("Claude system prompt contains a non-text block");
		}
		if (Object.keys(block).some((key) => !["type", "text", "cache_control"].includes(key))) {
			throw new Error("Unsupported Claude system prompt field: cannot preserve the text layout");
		}
		return { ...block, type: "text", text: block.text };
	});
}
function onlyText(message: unknown, role: string): string | undefined {
	if (!isRecord(message) || message.role !== role || Object.keys(message).some((key) => !["role", "content"].includes(key)) ||
		!Array.isArray(message.content) || message.content.length !== 1) return undefined;
	const block = message.content[0];
	return isRecord(block) && block.type === "text" && typeof block.text === "string" &&
		Object.keys(block).every((key) => ["type", "text"].includes(key)) ? block.text : undefined;
}

/**
 * Real-capture layout: two fixed system blocks; actual Pi instructions remain
 * system-role content at the start of messages, not synthetic conversation.
 * Only exact templates emitted by this project are unwrapped on replay.
 */
export function claudeCodePrompt(source: Record<string, unknown>): { system: SystemTextBlock[]; messages: unknown[] } {
	const blocks = textBlocks(source.system);
	const originalMessages = source.messages ?? [];
	if (!Array.isArray(originalMessages)) throw new Error("Claude messages must be an array");
	const messages = [...originalMessages];
	const texts = blocks.map((block) => block.text);
	const oldEnvelope = texts.length === 3 && isBilling(texts[0]) &&
		texts[1] === CLAUDE_CODE_IDENTITY && texts[2] === CLAUDE_CODE_CORE_PROMPT;
	let runtime: string;
	if (oldEnvelope) {
		// Migrate only the previous converter's exact synthetic preface. Never
		// remove ordinary user/assistant messages merely resembling an ACK.
		const instruction = onlyText(messages[0], "user");
		if (instruction?.startsWith(OLD_INSTRUCTIONS_PREFIX) && onlyText(messages[1], "assistant") === OLD_ACK) {
			runtime = instruction.slice(OLD_INSTRUCTIONS_PREFIX.length);
			messages.splice(0, 2);
		} else {
			// The full synthetic conversation is part of the migration template.
			// A near match is ordinary input, including every system block.
			runtime = texts.join("\n\n");
		}
	} else {
		let sdkIdentity = 0;
		while (texts[sdkIdentity] !== undefined && isBilling(texts[sdkIdentity])) sdkIdentity++;
		if (texts[sdkIdentity] === SDK_IDENTITY) texts.splice(0, sdkIdentity + 1);
		if (texts[0] === CLAUDE_CODE_IDENTITY && texts[1]?.startsWith(CLAUDE_CODE_PROMPT_PREFIX)) {
			texts.shift();
			texts[0] = texts[0].slice(CLAUDE_CODE_PROMPT_PREFIX.length);
		}
		runtime = texts.join("\n\n");
	}
	if (runtime.length > 0) {
		messages.unshift({ role: "system", content: [{ type: "text", text: runtime }] });
	}
	return {
		system: [
			{ type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: EPHEMERAL },
			{ type: "text", text: CLAUDE_CODE_PROMPT_PREFIX, cache_control: EPHEMERAL },
		],
		messages,
	};
}
