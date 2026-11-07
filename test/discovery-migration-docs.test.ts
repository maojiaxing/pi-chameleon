import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const readGuide = () => readFile(new URL("../README.md", import.meta.url), "utf8");
const readExample = async (name: string) => JSON.parse(await readFile(new URL(`../examples/${name}`, import.meta.url), "utf8"));

function section(guide: string, heading: string): string {
	const start = guide.indexOf(`## ${heading}\n`);
	assert.ok(start >= 0, `missing user guidance: ${heading}`);
	const end = guide.indexOf("\n## ", start + 1);
	return guide.slice(start, end < 0 ? undefined : end);
}

test("migration guide starts without built-in members and leaves the user's default unchanged", async () => {
	const guide = await readGuide();
	assert.ok(!/已注册默认模型|^## 默认模型$/m.test(guide), "do not promise built-in default members");
	assert.ok(/不预设模型成员/.test(guide), "explain the empty initial catalog");
	assert.ok(/自动成员.*完整发现.*成功快照/.test(guide), "explain the only automatic member sources");
	assert.ok(/首次.*无适用缓存.*无用户显式模型/.test(guide), "guide the first load without a fallback");
	assert.ok(/\/reload.*后台/.test(guide), "reload is a background update, not a network barrier");
	assert.ok(/默认模型.*既未发现.*未显式添加/.test(guide), "guide a missing configured default");
	assert.ok(/不自动改写.*settings\.json/.test(guide), "preserve the user's default settings");
});

test("all copyable provider JSON blocks match linked examples and retain native configuration fields", async () => {
	const guide = await readGuide();
	const copies = [...guide.matchAll(/```json(?:[ \t]+[^\n]*)?\r?\n([\s\S]*?)\r?\n```/g)]
		.map((match) => JSON.parse(match[1]))
		.filter((config) => config.providers !== undefined);
	const names = ["models.json", "models-bearer.json", "models-separate.json", "models-custom.json"];
	const examples = await Promise.all(names.map(readExample));
	assert.deepEqual(copies, examples, "each complete provider example must be copyable verbatim");
	for (const [index, config] of examples.entries()) {
		assert.ok(guide.includes(`(examples/${names[index]})`), "link every copyable example");
		for (const id of Object.keys(config.providers)) {
			assert.ok(["chameleon-claude", "chameleon-codex"].includes(id));
			const provider = config.providers[id];
			assert.ok(Object.keys(provider).every((key) => ["baseUrl", "apiKey", "authHeader", "models", "modelOverrides"].includes(key)), "no extension-specific credentials scheme");
			assert.ok(provider.baseUrl.startsWith("https://") && provider.baseUrl.includes("example.com"));
			assert.ok(provider.apiKey.startsWith("replace-with-your-"), "examples never contain real keys");
		}
	}
	for (const id of ["chameleon-claude", "chameleon-codex"]) {
		assert.deepEqual(Object.keys(examples[0].providers[id]).sort(), ["apiKey", "baseUrl"]);
		assert.equal(examples[1].providers[id].authHeader, true);
		assert.ok(examples[2].providers[id].modelOverrides);
	}
	assert.notEqual(examples[2].providers["chameleon-claude"].baseUrl, examples[2].providers["chameleon-codex"].baseUrl);
	assert.notEqual(examples[2].providers["chameleon-claude"].apiKey, examples[2].providers["chameleon-codex"].apiKey);
});

test("a user can add the documented private alias through real Pi without a discovered member", { timeout: 20_000 }, async () => {
	const example = await readExample("models-custom.json");
	const dir = await mkdtemp(join(tmpdir(), "pi-chameleon-migration-docs-"));
	try {
		const modelsPath = join(dir, "models.json");
		await writeFile(modelsPath, JSON.stringify(example));
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
			modelsPath, allowModelNetwork: false, refreshOnCreate: false,
		});
		assert.equal(runtime.getError(), undefined);
		const model = runtime.getModel("chameleon-codex", "private-codex-alias");
		assert.ok(model, "the explicit alias must not depend on API discovery");
		assert.equal(model.api, "openai-responses");
		assert.equal(model.baseUrl, "https://relay.example.com/v1");
		assert.equal(model.reasoning, false);
		assert.deepEqual(model.input, ["text"]);
		assert.equal(model.contextWindow, 32768);
		assert.equal(model.maxTokens, 4096);
		assert.deepEqual(model.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 });
		assert.ok(model.name.includes("synthetic example"), "example values are not verified relay facts");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("users can copy scoped refresh commands and understand stale catalogs, unknown fees and unverified safety", async () => {
	const guide = await readGuide();
	const discovery = section(guide, "模型发现");
	const refresh = section(guide, "目录刷新与缓存");
	const capabilities = section(guide, "能力与费用");
	const commands = /```text\r?\n([\s\S]*?)\r?\n```/.exec(refresh);
	assert.ok(commands, "provide copyable refresh invocations, not just optional-argument notation");
	assert.deepEqual(commands[1].trim().split(/\r?\n/), [
		"/chameleon-models-refresh", "/chameleon-models-refresh claude", "/chameleon-models-refresh codex",
	]);
	const requirements: [string, string, RegExp][] = [
		["Claude list path", discovery, /baseUrl.*\/v1\/models/],
		["Codex list path with gateway prefix", discovery, /gateway\/openai\/models/],
		["heuristic families, not chat verification", discovery, /启发式.*不是协议兼容.*真实聊天验证/],
		["unknown aliases remain explicit", discovery, /未知家族.*原生.*models.*显式添加/],
		["model picker freshness threshold", refresh, /\/model.*超过一小时/],
		["single network budget spans every page", refresh, /15 秒总网络预算.*所有分页.*不为每页重置/],
		["no per-chat discovery", refresh, /不在每次聊天前获取目录/],
		["one successful snapshot, replaced only on complete success", refresh, /单份最近完整成功快照[\s\S]*完整成功整体替换[\s\S]*获取失败保留成功快照/],
		["stale success does not hard expire", refresh, /不设年龄硬过期/],
		["identity changes do not reuse prior candidates", refresh, /有效凭据.*变化后不复用旧目录/],
		["permission suspension survives restart until success", refresh, /401\/403.*跨重启.*直到成功刷新/],
		["corrupt reads and unsaved in-memory success", refresh, /读取失败或损坏.*无缓存[\s\S]*写入失败.*本会话目录[\s\S]*新目录未保存[\s\S]*重启只恢复实际保存/],
		["unknown budgets are provisional", capabilities, /32768[\s\S]*4096[\s\S]*客户端预算/],
		["unknown inputs and reasoning are conservative", capabilities, /input: \["text"\][\s\S]*reasoning: false/],
		["reference and unknown estimates are not actual bills or free", capabilities, /参考费用.*不是中转站实际账单[\s\S]*0 占位[\s\S]*费用未知[\s\S]*不代表免费/],
		["safety boundaries still require final acceptance", refresh, /Windows ACL.*跨进程故障.*仍需最终验收/],
	];
	for (const [contract, text, pattern] of requirements) assert.ok(pattern.test(text), contract);
	assert.ok(/尚未完成最终真实 Pi 1\.5\.0.*验收/.test(guide));
	assert.ok(/未调用真实中转站/.test(guide));
});
