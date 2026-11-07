import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, type Api, type FetchFunction, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createChameleonExtension } from "../src/index.ts";
import { createSnapshotRepository } from "../src/discovery/snapshot.ts";
import { claudeTextResponse } from "./fixtures.ts";

test("defined empty PI_OFFLINE blocks startup, commands, and direct forced refresh in a real isolated session", { timeout: 40_000 }, async () => {
	if (process.env.CHAMELEON_TEST_OFFLINE !== "1") {
		// Node's child-v8 test protocol suppresses human stdout when inherited by a nested --test process.
		const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "", CHAMELEON_TEST_OFFLINE: "1" };
		delete env.NODE_TEST_CONTEXT;
		const result = await promisify(execFile)(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=defined empty PI_OFFLINE", fileURLToPath(import.meta.url)], {
			cwd: fileURLToPath(new URL("../", import.meta.url)), env, timeout: 30_000,
		}).catch((error: unknown) => {
			const failure = error as { code?: number | string; stdout?: string; stderr?: string };
			assert.fail(`offline child exited ${failure.code ?? "unknown"}\nstdout: ${failure.stdout ?? ""}\nstderr: ${failure.stderr ?? ""}`);
		});
		assert.match(result.stdout, /# pass 1\b/, `offline child stderr: ${result.stderr}`);
		return;
	}
	assert.equal(process.env.PI_OFFLINE, "");
	let requests = 0;
	await withSession(async () => { requests++; throw new Error("offline must not request a catalog"); }, async ({ session, registry, notifications }) => {
		await registry.refresh({ providers: ["chameleon-codex", "chameleon-claude"], allowNetwork: true, force: true });
		await session.prompt("/chameleon-models-refresh");
		assert.equal(requests, 0);
		assert.equal(session.model?.id, "explicit-session");
		assert.ok(notifications.some((n) => n.includes("离线模式")));
	});
});

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
const explicit: Model<Api> = {
	id: "explicit-session", name: "Explicit session fixture", provider: "chameleon-codex", api: "openai-responses",
	baseUrl: "https://relay.example.test/v1", reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
async function withSession(fetch: FetchFunction, run: (h: {
	session: AgentSession; registry: ModelRegistry; runtime: ModelRuntime; notifications: string[]; pi: ExtensionAPI;
	loader: DefaultResourceLoader; contexts: ExtensionContext[]; startReasons: string[];
}) => Promise<void>, options: { settings?: Parameters<typeof SettingsManager.inMemory>[0] } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-lifecycle-"));
	let session: AgentSession | undefined;
	try {
		const agentDir = join(directory, "agent");
		await mkdir(agentDir);
		const path = join(agentDir, "models.json");
		await writeFile(path, JSON.stringify({ providers: {
			"chameleon-codex": { baseUrl: "https://relay.example.test/v1", apiKey: "synthetic-session-key", authHeader: true,
				models: [{ ...explicit, baseUrl: undefined, provider: undefined }] },
			"chameleon-claude": { baseUrl: "https://relay.example.test", apiKey: "synthetic-session-key" },
		} }));
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(), modelsPath: path, modelsStore: new InMemoryModelsStore(),
			refreshOnCreate: false, allowModelNetwork: false,
		});
		const settings = SettingsManager.inMemory(options.settings ?? { defaultProvider: "chameleon-codex", defaultModel: "explicit-session" });
		const registry = new ModelRegistry(runtime);
		let pi!: ExtensionAPI;
		const contexts: ExtensionContext[] = [];
		const startReasons: string[] = [];
		const startupRequests = new Set<string>();
		const startupArmed = deferred<void>();
		const observedFetch: FetchFunction = (input, init) => {
			startupRequests.add(new Headers(init?.headers).has("authorization") ? "codex" : "claude");
			if (startupRequests.size === 2) startupArmed.resolve();
			return fetch(input, init);
		};
		const loader = new DefaultResourceLoader({
			cwd: directory, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true,
			noPromptTemplates: true, noContextFiles: true,
			extensionFactories: [{ name: "chameleon-test", factory: createChameleonExtension({
				fetch: observedFetch, repository: createSnapshotRepository({ directory: join(directory, "catalogs") }),
			}) }, { name: "public-test-observer", factory(api) {
				pi = api;
				api.on("session_start", (event, context) => { contexts.push(context); startReasons.push(event.reason); });
			} }],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const created = await createAgentSession({
			cwd: directory, agentDir, modelRuntime: runtime, resourceLoader: loader,
			settingsManager: settings, sessionManager: SessionManager.inMemory(directory), model: explicit, noTools: "all",
		});
		session = created.session;
		// Native registration queues cache-only refreshes. Let them enter, then await the public initialization barrier.
		await new Promise<void>((resolve) => setImmediate(resolve));
		await runtime.refresh({ providers: ["chameleon-codex", "chameleon-claude"], allowNetwork: false });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const notifications: string[] = [];
		await session.bindExtensions({ uiContext: { notify(message) { notifications.push(message); } } as ExtensionUIContext, mode: "print" });
		// Wait for external startup GETs to be armed, not completed, before a test starts an ordinary host refresh.
		if (process.env.PI_OFFLINE === undefined) await startupArmed.promise;
		await run({ session, registry, runtime, notifications, get pi() { return pi; }, loader, contexts, startReasons });
	} finally {
		if (session) {
			await session.abort();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
		await rm(directory, { recursive: true, force: true, maxRetries: 3 });
	}
}

test("the real InlineExtension loader starts background discovery through public session binding without changing the current model", { timeout: 20_000 }, async () => {
	const codex = deferred<Response>();
	const claude = deferred<Response>();
	const bothStarted = deferred<void>();
	const requests: { url: string; headers: Headers }[] = [];
	const fetch: FetchFunction = async (url, init) => {
		requests.push({ url: String(url), headers: new Headers(init?.headers) });
		if (requests.length === 2) bothStarted.resolve();
		return new Headers(init?.headers).has("authorization") ? codex.promise : claude.promise;
	};
	await withSession(fetch, async ({ session, registry, notifications }) => {
		await bothStarted.promise;
		assert.equal(session.model?.id, "explicit-session");
		assert.deepEqual(registry.getAll().filter((m) => m.provider === "chameleon-codex").map((m) => m.id), ["explicit-session"]);
		codex.resolve(Response.json({ data: [{ id: "gpt-session-discovered" }] }));
		claude.resolve(Response.json({ data: [{ id: "claude-session-discovered" }], has_more: false }));
		// A real ordinary host refresh joins startup work and provides a completion barrier.
		await registry.refresh({ providers: ["chameleon-codex", "chameleon-claude"], allowNetwork: true });
		assert.ok(registry.find("chameleon-codex", "gpt-session-discovered"));
		assert.ok(registry.find("chameleon-claude", "claude-session-discovered"));
		assert.equal(session.model?.id, "explicit-session");
		assert.equal(requests.length, 2);
		assert.equal(requests[0].headers.get("authorization") ?? requests[1].headers.get("authorization"), "Bearer synthetic-session-key");
		assert.ok(notifications.some((n) => n.includes("加载")));
	});
});

test("public session.reload cancels the old epoch, restores cache before startup GETs, and preserves selection and defaults", { timeout: 40_000 }, async () => {
	let phase: "old-pending" | "reloaded" | "cached-reload" = "old-pending";
	const oldStarted = deferred<void>();
	const reloadStarted = deferred<void>();
	const cachedReloadStarted = deferred<void>();
	const oldResponses = { codex: deferred<Response>(), claude: deferred<Response>() };
	const reloadResponses = { codex: deferred<Response>(), claude: deferred<Response>() };
	const cachedReloadResponses = { codex: deferred<Response>(), claude: deferred<Response>() };
	const requests: { phase: string; family: "codex" | "claude"; signal: AbortSignal }[] = [];
	let hRef: { registry: ModelRegistry } | undefined;
	const fetch: FetchFunction = async (_url, init) => {
		const family = new Headers(init?.headers).has("authorization") ? "codex" : "claude";
		assert.ok(init?.signal);
		requests.push({ phase, family, signal: init.signal });
		if (phase === "old-pending") {
			if (requests.filter((r) => r.phase === phase).length === 2) oldStarted.resolve();
			return oldResponses[family].promise; // Deliberately ignores cancellation: a late GET must remain fenced.
		}
		if (phase === "cached-reload") {
			if (requests.filter((r) => r.phase === phase).length === 1) {
				// The first startup GET after reload must already see the restored cache snapshot.
				assert.ok(hRef!.registry.find("chameleon-codex", "gpt-reload-new"), "restored cache must be visible before the first startup GET after reload");
				assert.ok(hRef!.registry.find("chameleon-claude", "claude-reload-new"));
			}
			if (requests.filter((r) => r.phase === phase).length === 2) cachedReloadStarted.resolve();
			return cachedReloadResponses[family].promise;
		}
		if (requests.filter((r) => r.phase === phase).length === 2) reloadStarted.resolve();
		return reloadResponses[family].promise;
	};
	await withSession(fetch, async (h) => {
		hRef = h;
		const defaults = h.pi.getSettings();
		const oldContext = h.contexts[0];
		await oldStarted.promise;
		const oldRefresh = h.registry.refresh({ providers: ["chameleon-codex", "chameleon-claude"], allowNetwork: true });
		const oldRequests = requests.filter((r) => r.phase === "old-pending");
		phase = "reloaded";
		await h.session.reload({ beforeSessionStart: async () => {
			// Reload queues native provider registration just like first initialization.
			await new Promise<void>((resolve) => setImmediate(resolve));
			await h.runtime.refresh({ providers: ["chameleon-codex", "chameleon-claude"], allowNetwork: false });
			assert.equal(h.registry.find("chameleon-codex", "gpt-reload-new"), undefined);
			assert.equal(requests.filter((r) => r.phase === "reloaded").length, 0, "cache initialization must not start GETs");
		} });
		await reloadStarted.promise;
		assert.deepEqual(h.startReasons, ["startup", "reload"]);
		assert.notEqual(h.contexts[1], oldContext);
		assert.ok(oldRequests.every((r) => r.signal.aborted), "old discovery must be cancelled on real reload");
		assert.equal(h.session.model?.id, "explicit-session");
		reloadResponses.codex.resolve(Response.json({ data: [{ id: "gpt-reload-new" }] }));
		reloadResponses.claude.resolve(Response.json({ data: [{ id: "claude-reload-new" }], has_more: false }));
		await h.registry.refresh({ providers: ["chameleon-codex", "chameleon-claude"], allowNetwork: true });
		oldResponses.codex.resolve(Response.json({ data: [{ id: "gpt-obsolete-epoch" }] }));
		oldResponses.claude.resolve(Response.json({ data: [{ id: "claude-obsolete-epoch" }], has_more: false }));
		await oldRefresh;
		assert.ok(h.registry.find("chameleon-codex", "gpt-reload-new"));
		assert.ok(h.registry.find("chameleon-claude", "claude-reload-new"));
		assert.equal(h.registry.find("chameleon-codex", "gpt-obsolete-epoch"), undefined);
		assert.equal(h.registry.find("chameleon-claude", "claude-obsolete-epoch"), undefined);
		assert.equal(h.session.model?.id, "explicit-session", "reload must not silently choose a newly discovered ID");
		assert.deepEqual(h.pi.getSettings(), defaults);
		await h.pi.setModel(h.registry.find("chameleon-codex", "gpt-reload-new")!);
		phase = "cached-reload";
		await h.session.reload({ beforeSessionStart: async () => {
			// No GET may start before session_start; the pending cache restore itself must stay offline.
			assert.equal(requests.filter((r) => r.phase === "cached-reload").length, 0);
		} });
		await cachedReloadStarted.promise;
		assert.equal(h.session.model?.id, "gpt-reload-new");
		cachedReloadResponses.codex.resolve(Response.json({ data: [{ id: "gpt-after-cached-reload" }] }));
		cachedReloadResponses.claude.resolve(Response.json({ data: [{ id: "claude-after-cached-reload" }], has_more: false }));
		await h.registry.refresh({ providers: ["chameleon-codex", "chameleon-claude"], allowNetwork: true });
		assert.deepEqual(h.startReasons, ["startup", "reload", "reload"]);
		assert.ok(h.registry.find("chameleon-codex", "gpt-after-cached-reload"));
		assert.equal(h.session.model?.id, "gpt-reload-new", "a removed selected ID remains the user's selection");
		assert.deepEqual(h.pi.getSettings(), defaults);
		assert.ok(h.notifications.some((n) => n.includes("保留当前会话选择")));
	});
});

test("the real session command force-refreshes the requested provider or both and safely reports results without changing defaults", { timeout: 20_000 }, async () => {
	const requests: { url: string; headers: Headers }[] = [];
	const ready = deferred<void>();
	const startedProviders = new Set<string>();
	let failClaude = false;
	const fetch: FetchFunction = async (url, init) => {
		const headers = new Headers(init?.headers);
		requests.push({ url: String(url), headers });
		startedProviders.add(headers.has("authorization") ? "codex" : "claude");
		if (startedProviders.size === 2) ready.resolve();
		if (!headers.has("authorization") && failClaude) return new Response("synthetic-session-key private rejection", { status: 401 });
		return Response.json(headers.has("authorization") ? { data: [{ id: "gpt-command-candidate" }] }
			: { data: [{ id: "claude-command-candidate" }], has_more: false });
	};
	await withSession(fetch, async ({ session, registry, notifications, pi, loader }) => {
		await ready.promise;
		await registry.refresh({ providers: ["chameleon-codex", "chameleon-claude"], allowNetwork: true });
		assert.ok(loader.getExtensions().extensions.some((extension) => extension.commands.has("chameleon-models-refresh")));
		const defaults = pi.getSettings();
		const before = requests.length;
		await session.prompt("/chameleon-models-refresh codex");
		assert.equal(requests.length, before + 1);
		assert.equal(requests.at(-1)?.headers.get("authorization"), "Bearer synthetic-session-key");
		failClaude = true;
		await session.prompt("/chameleon-models-refresh");
		assert.equal(requests.length, before + 3);
		assert.ok(notifications.some((n) => n.includes("Claude") && n.includes("暂停")));
		assert.ok(notifications.some((n) => n.includes("Codex") && n.includes("已更新")));
		assert.ok(notifications.every((n) => !n.includes("synthetic-session-key") && !n.includes("private rejection")));
		assert.deepEqual(pi.getSettings(), defaults);
		assert.equal(session.model?.id, "explicit-session");
		await session.prompt("/chameleon-models-refresh unknown");
		assert.equal(requests.length, before + 3);
		assert.match(notifications.at(-1)!, /chameleon-models-refresh.*claude.*codex/);
	});
});

test("model selection explains unknown and reference costs and missing defaults without rewriting settings", { timeout: 20_000 }, async () => {
	const fetch: FetchFunction = async (_url, init) => Response.json(new Headers(init?.headers).has("authorization")
		? { data: [{ id: "gpt-unconfirmed-session" }, { id: "gpt-5.3-codex" }] } : { data: [], has_more: false });
	await withSession(fetch, async ({ session, registry, notifications, pi }) => {
		await registry.refresh({ providers: ["chameleon-codex", "chameleon-claude"], allowNetwork: true });
		const settings = pi.getSettings();
		await session.prompt("/chameleon-models-refresh codex");
		assert.ok(notifications.some((n) => n.includes("默认模型") && n.includes("显式")));
		await pi.setModel(registry.find("chameleon-codex", "gpt-unconfirmed-session")!);
		assert.ok(notifications.some((n) => n.includes("临时客户端预算") && n.includes("不代表免费")));
		await pi.setModel(registry.find("chameleon-codex", "gpt-5.3-codex")!);
		assert.ok(notifications.some((n) => n.includes("参考费用") && n.includes("不是中转站账单")));
		assert.deepEqual(pi.getSettings(), settings);
	}, { settings: { defaultProvider: "chameleon-codex", defaultModel: "gpt-configured-missing" } });
});

test("a host registry refresh rebinds same-ID metadata only after its snapshot is updated and preserves then clamps thinking", { timeout: 20_000 }, async () => {
	let window = 200_000;
	let thinking = true;
	const fetch: FetchFunction = async (_url, init) => Response.json(new Headers(init?.headers).has("authorization")
		? { data: [] } : { data: [{ id: "claude-idle-session", max_input_tokens: window, max_tokens: 4_096,
			capabilities: { thinking: { supported: thinking } } }], has_more: false });
	await withSession(fetch, async ({ session, registry, pi }) => {
		await registry.refresh({ providers: ["chameleon-claude"], allowNetwork: true });
		await pi.setModel(registry.find("chameleon-claude", "claude-idle-session")!);
		pi.setThinkingLevel("high");
		assert.equal(pi.getThinkingLevel(), "high");
		window = 65_536;
		await registry.refresh({ providers: ["chameleon-claude"], allowNetwork: true, force: true });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(session.model?.contextWindow, 65_536);
		assert.equal(pi.getThinkingLevel(), "high");
		thinking = false;
		await registry.refresh({ providers: ["chameleon-claude"], allowNetwork: true, force: true });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(session.model?.reasoning, false);
		assert.equal(pi.getThinkingLevel(), "off");
	});
});

test("busy same-ID changes wait for a real agent_settled event and removed or suspended models never replace the active selection", { timeout: 20_000 }, async () => {
	let window = 32_768;
	let removed = false;
	let suspended = false;
	const fetch: FetchFunction = async (_url, init) => {
		if (new Headers(init?.headers).has("authorization")) return Response.json({ data: [] });
		if (suspended) return new Response("denied synthetic-session-key", { status: 403 });
		return Response.json({ data: removed ? [] : [{ id: "claude-busy-session", max_input_tokens: window, max_tokens: 4_096 }], has_more: false });
	};
	await withSession(fetch, async ({ session, registry, pi, notifications }) => {
		await registry.refresh({ providers: ["chameleon-codex", "chameleon-claude"], allowNetwork: true });
		const chosen = registry.find("chameleon-claude", "claude-busy-session")!;
		await pi.setModel(chosen);
		const started = deferred<void>();
		const release = deferred<Response>();
		const chatRequests: number[] = [];
		session.agent.streamFunction = (model, transcript, options) => registry.streamSimple(model, transcript, { ...options,
			fetch: async () => { chatRequests.push(model.contextWindow); started.resolve(); return release.promise; },
		});
		const prompt = session.prompt("Reply ok with the selected model.");
		await started.promise;
		assert.equal(session.isIdle, false);
		window = 12_000;
		await registry.refresh({ providers: ["chameleon-claude"], allowNetwork: true, force: true });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(registry.find("chameleon-claude", chosen.id)?.contextWindow, 12_000);
		assert.equal(session.model?.contextWindow, 32_768);
		assert.deepEqual(chatRequests, [32_768]);
		release.resolve(claudeTextResponse());
		await prompt;
		assert.equal(session.model?.contextWindow, 12_000);
		removed = true;
		await registry.refresh({ providers: ["chameleon-claude"], allowNetwork: true, force: true });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(session.model?.id, chosen.id);
		assert.equal(session.model?.contextWindow, 12_000);
		assert.ok(notifications.some((n) => n.includes("当前模型") && n.includes("不自动切换")));
		suspended = true;
		await registry.refresh({ providers: ["chameleon-claude"], allowNetwork: true, force: true });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(session.model?.id, chosen.id);
		assert.equal(session.model?.contextWindow, 12_000);
	});
});
