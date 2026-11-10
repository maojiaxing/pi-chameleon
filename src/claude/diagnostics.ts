import { randomUUID } from "node:crypto";
import type { FetchFunction, StreamOptions } from "@earendil-works/pi-ai";
import { claudeCodeStream, claudeCodeStreamSimple } from "./stream.ts";

type Stage = "adapted" | "final-observed" | "dispatched" | "http" | "terminal";
type Failure = "unknown" | "hook" | "transport-unknown" | "http-error" | "stream-error" | "cancelled";
interface Summary {
	id: string;
	rules: { name: "claude-code"; version: "2.1.274"; applied: boolean }[];
	stages: Stage[];
	toolCount?: number;
	blockCount?: number;
	cache?: "off" | "short" | "long" | "mixed" | "unknown";
	identityConsistent?: boolean;
	httpStatus?: number;
	terminal?: "success" | "error" | "cancelled" | "unknown";
	failure?: Failure;
	incomplete: boolean;
}

// The API router survives module reloads. Weak ownership plus explicit deregistration
// avoids pinning extension instances; session identity is routing state, never a record.
const registryKey = Symbol.for("pi-chameleon.diagnostics.owners.v1");
function owners(): Set<WeakRef<ClaudeDiagnostics>> {
	const root = globalThis as typeof globalThis & { [registryKey]?: Set<WeakRef<ClaudeDiagnostics>> };
	return root[registryKey] ??= new Set();
}
function liveOwners(): ClaudeDiagnostics[] {
	const live: ClaudeDiagnostics[] = [];
	for (const ref of owners()) {
		const owner = ref.deref();
		if (owner) live.push(owner); else owners().delete(ref);
	}
	return live;
}
export function diagnosticsForSession(sessionId: string | undefined): ClaudeDiagnostics | undefined {
	const live = liveOwners();
	const matches = sessionId === undefined ? live : live.filter((owner) => owner.owns(sessionId));
	if (sessionId !== undefined && matches.length === 1) return matches[0];
	for (const owner of matches) owner.markIncomplete();
	return undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Only allowlisted primitives leave this transient final-wire projection. */
function project(input: Parameters<FetchFunction>[0], init: Parameters<FetchFunction>[1], summary: Summary): void {
	// Never read or clone a Request/Response stream. Safety transport supplies JSON text.
	if (typeof init?.body !== "string") { summary.incomplete = true; return; }
	const body = object(JSON.parse(init.body));
	if (!body) { summary.incomplete = true; return; }
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const blocks: unknown[] = [...(Array.isArray(body.system) ? body.system : [])];
	if (Array.isArray(body.messages)) for (const message of body.messages) {
		const content = object(message)?.content;
		if (Array.isArray(content)) blocks.push(...content);
		else if (typeof content === "string") blocks.push(undefined);
	}
	summary.toolCount = tools.length;
	summary.blockCount = blocks.length;
	const cache = new Set<"short" | "long" | "unknown">();
	for (const item of [...tools, ...blocks]) {
		const value = object(item)?.cache_control;
		if (value === undefined) continue;
		const control = object(value);
		cache.add(control?.type !== "ephemeral" ? "unknown" : control.ttl === "1h" ? "long"
			: control.ttl === undefined || control.ttl === "5m" ? "short" : "unknown");
	}
	summary.cache = cache.has("unknown") ? "unknown" : cache.size > 1 ? "mixed" : cache.values().next().value ?? "off";
	const user = object(body.metadata)?.user_id;
	const identity = object(typeof user === "string" ? JSON.parse(user) : user);
	const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
	summary.identityConsistent = typeof identity?.session_id === "string"
		&& identity.session_id === headers.get("x-claude-code-session-id");
}

/** Per extension invocation, disabled by default; only bounded safe summaries retained. */
export class ClaudeDiagnostics {
	private enabled = false;
	private incomplete = false;
	private epoch = 0;
	private sessionId: string | undefined;
	private registration: WeakRef<ClaudeDiagnostics> | undefined;
	private inflight = new Map<string, Summary>();
	private latest: Summary | null = null;

	owns(sessionId: string): boolean { return this.sessionId === sessionId; }
	markIncomplete(): void { if (this.enabled) this.incomplete = true; }
	private clear(): void {
		this.epoch++;
		this.inflight.clear();
		this.latest = null;
		this.incomplete = false;
	}
	start(sessionId: string): void {
		this.shutdown();
		this.sessionId = sessionId;
		this.registration = new WeakRef(this);
		owners().add(this.registration);
	}
	shutdown(): void {
		this.enabled = false;
		this.clear();
		if (this.registration) owners().delete(this.registration);
		this.registration = undefined;
		this.sessionId = undefined;
	}
	command(args: string, notify: (message: string) => void): void {
		const command = args.trim();
		if (command === "off") { this.enabled = false; this.clear(); }
		else if (command === "on" && !this.enabled) { this.clear(); this.enabled = true; }
		try {
			if (!["on", "off", "status"].includes(command)) notify("Usage: /chameleon-diagnostics on|off|status");
			else notify(`Chameleon diagnostics: ${JSON.stringify({ enabled: this.enabled, incomplete: this.incomplete,
				inflight: [...this.inflight.values()], latest: this.latest })}`);
		} catch { this.markIncomplete(); }
	}

	readonly stream: typeof claudeCodeStream = (model, context, options) => this.observe(claudeCodeStream, model, context, options);
	readonly streamSimple: typeof claudeCodeStreamSimple = (model, context, options) => this.observe(claudeCodeStreamSimple, model, context, options);

	private observe(delegate: typeof claudeCodeStream, ...args: Parameters<typeof claudeCodeStream>): ReturnType<typeof claudeCodeStream> {
		const [model, context, options] = args;
		if (!this.enabled) return delegate(...args);
		if (!this.sessionId || options?.sessionId !== this.sessionId || diagnosticsForSession(this.sessionId) !== this) {
			this.markIncomplete(); return delegate(...args);
		}
		if (this.inflight.size >= 8) { this.markIncomplete(); return delegate(...args); }
		const epoch = this.epoch;
		let summary: Summary;
		try {
			summary = { id: randomUUID(), rules: [{ name: "claude-code", version: "2.1.274", applied: false }], stages: [], incomplete: false };
			this.inflight.set(summary.id, summary);
		} catch { this.markIncomplete(); return delegate(...args); }
		const current = () => epoch === this.epoch && this.enabled && this.inflight.get(summary.id) === summary;
		const safe = (update: () => void) => {
			if (!current()) return;
			try { update(); } catch { summary.incomplete = true; }
			if (summary.incomplete) this.incomplete = true;
		};
		const stage = (value: Stage) => { if (!summary.stages.includes(value)) summary.stages.push(value); };
		const finish = (stopReason: unknown) => safe(() => {
			stage("terminal");
			if (stopReason === "aborted") { summary.terminal = "cancelled"; summary.failure = "cancelled"; }
			else if (stopReason === "error") {
				summary.terminal = "error";
				summary.failure ??= summary.httpStatus === undefined ? "unknown" : summary.httpStatus >= 400 ? "http-error" : "stream-error";
			} else if (stopReason === "stop" || stopReason === "length" || stopReason === "toolUse") summary.terminal = "success";
			else { summary.terminal = "unknown"; summary.failure ??= "unknown"; summary.incomplete = true; }
			this.inflight.delete(summary.id);
			this.latest = summary;
		});
		const forget = (reason: "unknown" | "cancelled") => safe(() => {
			summary.incomplete = true;
			summary.failure = reason;
			summary.terminal = reason;
			stage("terminal");
			this.inflight.delete(summary.id);
			this.latest = summary;
		});
		const transport = options?.fetch ?? globalThis.fetch;
		const observed: StreamOptions = {
			...options,
			onPayload: async (payload, nativeModel) => {
				// Entry proves adaptation before the caller hook, not final normalization.
				safe(() => { stage("adapted"); summary.rules[0]!.applied = true; });
				try { return await options?.onPayload?.(payload, nativeModel); }
				catch (error) { safe(() => { summary.failure = "hook"; }); throw error; }
			},
			fetch: async (input, init) => {
				safe(() => { stage("final-observed"); project(input, init, summary); });
				let response: Response;
				try { response = await transport(input, init); }
				catch (error) { safe(() => { summary.failure = options?.signal?.aborted ? "cancelled" : "transport-unknown"; }); throw error; }
				safe(() => {
					stage("dispatched");
					const status = response.status;
					if (Number.isInteger(status) && status >= 100 && status <= 599) { stage("http"); summary.httpStatus = status; }
					else summary.incomplete = true;
				});
				return response;
			},
		};
		try {
			const events = delegate(model, context, observed);
			// result() does not consume the event iterator; return the very same stream.
			void events.result().then((message) => {
				try { finish(message.stopReason); } catch { forget("unknown"); }
			}, () => finish("error")).catch(() => forget("unknown"));
			return events;
		} catch (error) { finish("error"); throw error; }
	}
}
