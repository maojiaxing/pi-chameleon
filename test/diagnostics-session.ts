import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Api, type FetchFunction, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createChameleonExtension } from "../src/index.ts";
import { createSnapshotRepository } from "../src/discovery/snapshot.ts";
import { claudeTextResponse } from "./fixtures.ts";

export const diagnosticModel: Model<Api> = {
	id: "claude-private-model-sentinel", name: "private-name-sentinel", provider: "chameleon-claude", api: "anthropic-messages",
	baseUrl: "https://private-url-sentinel.example.test", reasoning: false, input: ["text"], contextWindow: 32_768, maxTokens: 4_096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
export async function diagnosticSession(options: { discovered?: boolean; manager?: SessionManager } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pi-chameleon-diagnostics-"));
	const agentDir = join(directory, "agent");
	await mkdir(agentDir);
	const path = join(agentDir, "models.json");
	await writeFile(path, JSON.stringify({ providers: {
		"chameleon-claude": { baseUrl: diagnosticModel.baseUrl, apiKey: "private-key-sentinel",
			models: options.discovered ? [] : [{ ...diagnosticModel, baseUrl: undefined, provider: undefined }] },
	} }));
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: path,
		modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
	const registry = new ModelRegistry(runtime);
	const settings = SettingsManager.inMemory({ defaultProvider: "chameleon-claude", defaultModel: diagnosticModel.id });
	const started = deferred<void>();
	const loader = new DefaultResourceLoader({ cwd: directory, agentDir, settingsManager: settings,
		noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [{ name: "diagnostic-real-extension", factory: createChameleonExtension({
			repository: createSnapshotRepository({ directory: join(directory, "catalogs") }),
			fetch: async () => { started.resolve(); return Response.json({ data: options.discovered ? [{ id: diagnosticModel.id }] : [], has_more: false }); },
		}) }],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const manager = options.manager ?? SessionManager.inMemory(directory);
	const { session } = await createAgentSession({ cwd: directory, agentDir, modelRuntime: runtime, resourceLoader: loader,
		settingsManager: settings, sessionManager: manager, model: diagnosticModel, noTools: "all" });
	const notifications: string[] = [];
	let uiFails = false;
	const ui = { notify(message: string) { if (uiFails) throw new Error("private-ui-error-sentinel"); notifications.push(message); } } as ExtensionUIContext;
	await new Promise<void>((resolve) => setImmediate(resolve));
	await runtime.refresh({ providers: ["chameleon-claude"], allowNetwork: false });
	await session.bindExtensions({ uiContext: ui, mode: "print" });
	await started.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	await registry.refresh({ providers: ["chameleon-claude"], allowNetwork: true, force: true });
	const model = registry.find("chameleon-claude", diagnosticModel.id)!;
	assert.ok(model);
	let chatFetch: FetchFunction = async () => claudeTextResponse();
	session.agent.streamFunction = (selected, transcript, streamOptions) => registry.streamSimple(selected, transcript, { ...streamOptions, fetch: chatFetch });
	return {
		session, registry, model, manager, directory, notifications,
		setFetch(fetch: FetchFunction) { chatFetch = fetch; },
		failUI(value: boolean) { uiFails = value; },
		async command(command: string) { await session.prompt(`/chameleon-diagnostics ${command}`); },
		async status(): Promise<any> {
			await session.prompt("/chameleon-diagnostics status");
			const message = notifications.at(-1)!;
			assert.match(message, /^Chameleon diagnostics: /);
			return JSON.parse(message.slice("Chameleon diagnostics: ".length));
		},
		async close() {
			await session.abort();
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
			await rm(directory, { recursive: true, force: true, maxRetries: 3 });
		},
	};
}
