import { CLAUDE_CODE_IDENTITY, EPHEMERAL } from "./identity.ts";

interface SystemTextBlock {
	type: "text";
	text: string;
	cache_control?: typeof EPHEMERAL;
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

/** Replace only the leading Pi identity, retaining all actual runtime content. */
function replacePiIdentity(text: string): string {
	return text
		.replace(
			/^(\s*)You are an expert coding assistant operating inside pi(?:\.(?=\s|$)|(?=\s|$))/,
			`$1${CLAUDE_CODE_IDENTITY}`,
		)
		.replace(
			/^(\s*)You are a coding assistant running inside pi, a coding agent harness(?:\.(?=\s|$)|(?=\s|$))/,
			`$1${CLAUDE_CODE_IDENTITY}`,
		);
}

function composeClaudeCodePrompt(piPrompt: string): string {
	const runtime = piPrompt.startsWith(CLAUDE_CODE_PROMPT_PREFIX)
		? piPrompt.slice(CLAUDE_CODE_PROMPT_PREFIX.length)
		: piPrompt;
	return `${CLAUDE_CODE_PROMPT_PREFIX}${replacePiIdentity(runtime)}`;
}

/**
 * [Claude Code CLI identity] + [Claude Code core + Pi prompt].
 * No billing block (removed at the user's request; successful captures pass
 * without it). Pi's serialized text remains in order inside the runtime
 * section of the adapted main prompt. Compatibility prefixes from previous
 * rewrites — including legacy billing markers — are stripped, not duplicated.
 */
export function claudeCodeSystem(system: unknown): SystemTextBlock[] {
	const blocks =
		typeof system === "string"
			? [{ type: "text", text: system }]
			: system == null
				? []
				: system;
	if (!Array.isArray(blocks))
		throw new Error("Claude system prompt must be a string or text-block array");

	const texts = blocks.map((block: unknown): string => {
		if (
			typeof block !== "object" || block === null ||
			!("type" in block) || block.type !== "text" ||
			!("text" in block) || typeof block.text !== "string"
		) {
			throw new Error("Claude system prompt contains a non-text block");
		}
		return block.text;
	});

	// Only remove standalone leading compatibility blocks. Identical text
	// appearing later in rules, examples or project context is not rewritten.
	while (texts[0] !== undefined && /^x-anthropic-billing-header:[^\r\n]*$/.test(texts[0].trim())) {
		texts.shift();
	}
	// Migrate the old prefix, without ever emitting the Agent SDK identity.
	if (texts[0]?.trim() === "You are a Claude agent, built on Anthropic's Claude Agent SDK.") {
		texts.shift();
	}
	if (texts[0]?.trim() === CLAUDE_CODE_IDENTITY) texts.shift();

	const prompt = composeClaudeCodePrompt(texts.filter((text) => text.length > 0).join("\n\n"));
	return [
		{ type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: EPHEMERAL },
		{ type: "text", text: prompt, cache_control: EPHEMERAL },
	];
}
