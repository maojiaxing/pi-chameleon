import {
	createAssistantMessageEventStream,
	type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";

/**
 * Bidirectional tool-name mapping between Pi (lowercase/snake_case) and
 * Claude Code (PascalCase), applied to the serialized Anthropic payload on
 * the way out and restored on normalized stream events on the way back.
 *
 * Context-driven and case-insensitive: the wire→Pi map is built from the
 * tool names actually present in each request, so it never drifts from Pi's
 * live tool set (dsh claude.ts L34-108, adapted to pi-ai 1.5.0 where tools
 * travel inside the serialized payload, not `Context.tools`).
 */

const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
	grep: "Grep",
	glob: "Glob",
	ask_user_question: "AskUserQuestion",
	enter_plan_mode: "EnterPlanMode",
	exit_plan_mode: "ExitPlanMode",
	kill_shell: "KillShell",
	notebook_edit: "NotebookEdit",
	task: "Task",
	task_output: "TaskOutput",
	skill: "Skill",
	todo_write: "TodoWrite",
	web_fetch: "WebFetch",
	web_search: "WebSearch",
};

function wireToolName(name: string): string {
	return (
		CLAUDE_TOOL_NAMES[name.toLowerCase()] ??
		name.charAt(0).toUpperCase() + name.slice(1)
	);
}

/**
 * Rewrite every tool name inside an already-built Anthropic Messages payload
 * to Claude Code casing. Recognized shapes:
 * - `params.tools[]` definition (`name` + `input_schema`)
 * - `tool_use` block in message history
 * - `tool_reference` / `tool_definition` blocks inside system entries
 *   (mid-conversation tool changes)
 *
 * Records wire→Pi mappings into `fromWire`. Unknown objects are traversed
 * generically, so future payload shapes keep working.
 */
export function wireToolNamesDeep(value: unknown, fromWire: Map<string, string>): unknown {
	if (Array.isArray(value))
		return value.map((entry) => wireToolNamesDeep(entry, fromWire));
	if (typeof value !== "object" || value === null) return value;
	const record = value as Record<string, unknown>;

	const remap = (name: unknown): unknown => {
		if (typeof name !== "string") return name;
		const wire = wireToolName(name);
		if (!fromWire.has(wire.toLowerCase())) fromWire.set(wire.toLowerCase(), name);
		return wire;
	};

	const clone: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record)) {
		if (
			key === "name" &&
			(typeof record.input_schema === "object" ||
				record.type === "tool_use" ||
				record.type === "tool_reference" ||
				record.type === "tool_definition" ||
				record.type === "tool")
		) {
			clone.name = remap(child);
		} else if (
			["tools", "messages", "system", "content", "blocks", "tool", "definition", "tool_choice"].includes(key) &&
			typeof child === "object" && child !== null
		) {
			// Only protocol containers: schemas, tool inputs and user data are opaque.
			clone[key] = wireToolNamesDeep(child, fromWire);
		} else {
			clone[key] = child;
		}
	}
	return clone;
}

/** Recursively restore toolCall names from wire casing back to Pi names. */
function restoreName(
	value: unknown,
	fromWire: ReadonlyMap<string, string>,
): void {
	if (typeof value !== "object" || value === null) return;
	const record = value as Record<string, unknown>;
	if (record.type === "toolCall" && typeof record.name === "string") {
		record.name = fromWire.get(record.name.toLowerCase()) ?? record.name;
	}
	for (const key of ["content", "partial", "message", "error", "toolCall"]) {
		const child = record[key];
		if (Array.isArray(child)) child.forEach((entry) => restoreName(entry, fromWire));
		else restoreName(child, fromWire);
	}
}

/**
 * Pipe the inner stream into a fresh AssistantMessageEventStream, restoring
 * tool names on every event (including the terminal `done`/`error` message,
 * which also feeds `result()`).
 */
export function restoredStream(
	events: AssistantMessageEventStream,
	fromWire: () => ReadonlyMap<string, string>,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		try {
			for await (const event of events) {
				restoreName(event, fromWire());
				out.push(event);
			}
		} catch {
			// The inner stream terminates with `error` events rather than throwing;
			// guard anyway so the outer stream never hangs.
			out.end();
		}
	})();
	return out;
}
