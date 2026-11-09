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
 * Records a unique wire→Pi mapping into `fromWire`. Only protocol containers
 * are visited; schemas, arguments, nested results and unknown data are opaque.
 */
export function wireToolNamesDeep(value: unknown, fromWire: Map<string, string>): unknown {
	const remap = (name: unknown): unknown => {
		if (typeof name !== "string") return name;
		const wire = wireToolName(name);
		const key = wire.toLowerCase();
		const identity = fromWire.get(key);
		if (identity !== undefined && identity !== name) {
			throw new Error(`Claude tool wire-name collision: ${JSON.stringify(identity)} and ${JSON.stringify(name)}`);
		}
		fromWire.set(key, name);
		return wire;
	};

	type Container = "payload" | "message" | "block" | "definition" | "choice";
	const visit = (entry: unknown, container: Container): unknown => {
		if (Array.isArray(entry)) return entry.map((child) => visit(child, container));
		if (typeof entry !== "object" || entry === null) return entry;
		const record = entry as Record<string, unknown>;
		const clone = { ...record };
		if (container === "payload") {
			if (record.tools !== undefined) clone.tools = visit(record.tools, "definition");
			if (record.tool_choice !== undefined) clone.tool_choice = visit(record.tool_choice, "choice");
			if (record.messages !== undefined) clone.messages = visit(record.messages, "message");
			if (record.system !== undefined) clone.system = visit(record.system, "block");
		} else if (container === "message") {
			if (record.content !== undefined) clone.content = visit(record.content, "block");
		} else if (container === "definition" || (container === "choice" && record.type === "tool")) {
			if (typeof record.name === "string") clone.name = remap(record.name);
		} else if (container === "block") {
			if (["tool_use", "tool_reference", "tool_definition"].includes(String(record.type))) {
				if (typeof record.name === "string") clone.name = remap(record.name);
				if (record.type === "tool_definition" && record.definition !== undefined) clone.definition = visit(record.definition, "definition");
			} else if (record.type === "tool_addition" || record.type === "tool_removal") {
				if (record.tool !== undefined) clone.tool = visit(record.tool, "block");
			} else if (record.type === "text" && record.blocks !== undefined) {
				clone.blocks = visit(record.blocks, "block");
			}
			// tool_result.content is result data, not another protocol scope.
		}
		return clone;
	};
	return visit(value, "payload");
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
