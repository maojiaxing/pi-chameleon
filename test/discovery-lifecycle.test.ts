import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, type Api, type FetchFunction, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type ExtensionAPI, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createChameleonExtension } from "../src/index.ts";
import { createSnapshotRepository } from "../src/discovery/snapshot.ts";

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
	session: AgentSession; registry: ModelRegistry; notifications: string[]; pi: ExtensionAPI; loader: DefaultResourceLoader;
}) => Promise<void>) {
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
		const settings = SettingsManager.inMemory({ defaultProvider: "chameleon-codex", defaultModel: "explicit-session" });
		const registry = new ModelRegistry(runtime);
		let pi!: ExtensionAPI;
		const loader = new DefaultResourceLoader({
			cwd: directory, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true,
			noPromptTemplates: true, noContextFiles: true,
			extensionFactories: [{ name: "chameleon-test", factory: createChameleonExtension({
				fetch, repository: createSnapshotRepository({ directory: join(directory, "catalogs") }),
			}) }, { name: "public-test-observer", factory(api) { pi = api; } }],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const created = await createAgentSession({
			cwd: directory, agentDir, modelRuntime: runtime, resourceLoader: loader,
			settingsManager: settings, sessionManager: SessionManager.inMemory(directory), model: explicit, noTools: "all",
		});
		session = created.session;
		const notifications: string[] = [];
		await session.bindExtensions({ uiContext: { notify(message) { notifications.push(message); } } as ExtensionUIContext, mode: "print" });
		await run({ session, registry, notifications, pi, loader });
	} finally {
		if (session) { await session.abort(); session.dispose(); }
		await rm(directory, { recursive: true, force: true });
	}
}

test("the real InlineExtension loader starts background discovery through public session binding without changing the current model", async () => {
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
