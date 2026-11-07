import { join } from "node:path";
import type { FetchFunction } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createDiscoveryProvider, type DiscoveryState } from "./provider.ts";
import { createSnapshotRepository } from "./snapshot.ts";
import type { DiscoveryClock, RelayFamily, SnapshotRepository } from "./types.ts";

export interface ChameleonExtensionDependencies {
	fetch?: FetchFunction;
	clock?: DiscoveryClock;
	repository?: SnapshotRepository;
	directory?: string;
}
const families: readonly RelayFamily[] = ["claude", "codex"];
const messages: Record<DiscoveryState["status"], string> = {
	unconfigured: "未确认地址或鉴权；仅保留显式模型。请检查 Pi 原生供应商配置。",
	loading: "正在后台加载候选目录；候选不代表聊天协议已验证。",
	cache: "使用已核验的成功快照；候选不代表聊天协议已验证。",
	empty: "未发现候选模型；可刷新或通过 Pi 原生配置显式添加。",
	success: "候选目录已更新；候选不代表聊天协议已验证，请使用 /model 自行选择。",
	failed: "模型发现失败；保留适用且未停用的成功目录或显式模型，不自动重试。",
	unsaved: "新目录未保存（持久化未确认）；本会话仍使用新目录。",
	suspended: "列表认证或权限失败，自动候选已暂停；显式模型和当前会话选择保留，直到成功刷新。",
	"suspension-unsaved": "自动候选已暂停，但停用状态未保存；无法保证重启后继续停用，请修复缓存存储后刷新。",
};

/** Pi's public lifecycle is the only source of resolved relay access. */
export function createChameleonExtension(deps: ChameleonExtensionDependencies = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const repository = deps.repository ?? createSnapshotRepository({ directory: deps.directory ?? join(getAgentDir(), "chameleon-model-catalogs") });
		let ctx: ExtensionContext | undefined;
		let epoch = 0;
		let lifetime = new AbortController();
		let stopped = false;
		const states = new Map<string, DiscoveryState>();
		function notify(state: DiscoveryState) {
			states.set(state.provider, state);
			if (!ctx) return;
			const checked = state.checkedAt && Number.isFinite(state.checkedAt)
				? ` 最近成功时间：${new Date(state.checkedAt).toISOString()}。` : "";
			try { ctx.ui.notify(`${state.provider === "chameleon-claude" ? "Chameleon Claude" : "Chameleon Codex"}：${messages[state.status]}${checked}`,
				["failed", "unsaved", "suspended", "suspension-unsaved", "unconfigured"].includes(state.status) ? "warning" : "info"); } catch { /* A retired Pi context must never escape into an asynchronous callback. */ }
		}
		function makeProviders() {
			return families.map((family) => createDiscoveryProvider(family, {
				...deps, repository, onChange: notify,
				async resolveAccess() {
					const bound = ctx;
					const expected = epoch;
					if (!bound) return undefined;
					const id = `chameleon-${family}`;
					const resolved = await bound.modelRegistry.getProviderAuth(id);
					if (ctx !== bound || epoch !== expected || !resolved) return undefined;
					return { baseUrl: resolved.auth.baseUrl ?? bound.modelRegistry.getProvider(id)?.baseUrl ?? "",
						apiKey: resolved.auth.apiKey, headers: resolved.auth.headers };
				},
			}));
		}
		let providers = makeProviders();
		for (const discovery of providers) pi.registerProvider(discovery.provider);
		function missingDefault() {
			const bound = ctx;
			if (!bound) return;
			const settings = pi.getSettings();
			if (families.some((family) => settings.defaultProvider === `chameleon-${family}`)
				&& settings.defaultModel && !bound.modelRegistry.find(settings.defaultProvider!, settings.defaultModel)) {
				bound.ui.notify("Chameleon：配置的默认模型尚未发现，也未显式添加；请刷新目录或在 Pi 原生 models 中添加。默认设置和当前选择未修改。", "warning");
			}
		}
		pi.registerCommand("chameleon-models-refresh", {
			description: "刷新 Chameleon 候选模型目录，可指定 claude 或 codex",
			async handler(args, context) {
				const selected = args.trim();
				if (selected && selected !== "claude" && selected !== "codex") {
					context.ui.notify("用法：/chameleon-models-refresh [claude|codex]", "warning");
					return;
				}
				const bound = ctx;
				const expected = epoch;
				if (!bound || stopped) return;
				await Promise.all((selected ? [selected as RelayFamily] : families).map(async (family) => {
					const id = `chameleon-${family}` as DiscoveryState["provider"];
					try {
						const auth = await bound.modelRegistry.getProviderAuth(id);
						if (ctx !== bound || epoch !== expected) return;
						if (!auth) { notify({ provider: id, status: "unconfigured" }); return; }
						await bound.modelRegistry.refresh({ providers: [id], allowNetwork: !process.env.PI_OFFLINE, force: true, signal: lifetime.signal });
						if (ctx === bound && epoch === expected) {
							if (process.env.PI_OFFLINE) bound.ui.notify(`Chameleon ${family === "claude" ? "Claude" : "Codex"}：离线模式仅恢复缓存，未发起网络请求。`, "info");
							else notify(states.get(id) ?? { provider: id, status: "failed" });
						}
					} catch { if (ctx === bound && epoch === expected) notify({ provider: id, status: "failed" }); }
				}));
				if (ctx === bound && epoch === expected) missingDefault();
			},
		});
		pi.on("model_select", (event, context) => {
			if (!families.some((family) => event.model.provider === `chameleon-${family}`)) return;
			const details = ["Chameleon：所选模型是协议候选，不代表聊天已验证。"];
			if (event.model.name.includes("能力未确认")) details.push("能力未确认，临时客户端预算不代表上游实际限额；可通过 Pi 原生覆盖补正。");
			if (event.model.name.includes("参考费用")) details.push("参考费用来自本地官方资料，仅为估算，不是中转站账单。");
			if (event.model.name.includes("费用未知")) details.push("费用未知，原生统计的零占位不代表免费。");
			context.ui.notify(details.join(" "), "info");
		});
		pi.on("session_start", (_event, context) => {
			epoch++;
			lifetime.abort();
			lifetime = new AbortController();
			ctx = context;
			if (stopped) {
				providers = makeProviders();
				for (const discovery of providers) pi.registerProvider(discovery.provider);
				stopped = false;
			}
			const expected = epoch;
			// Startup/reload never waits for network. The public refresh remains a completion barrier for callers.
			void context.modelRegistry.refresh({ providers: families.map((family) => `chameleon-${family}`),
				allowNetwork: !process.env.PI_OFFLINE, force: true, signal: lifetime.signal }).then(() => {
				if (ctx === context && epoch === expected) missingDefault();
			}).catch(() => {
				if (ctx === context && epoch === expected) notify({ provider: "chameleon-codex", status: "failed" });
			});
		});
		pi.on("session_shutdown", () => {
			epoch++;
			ctx = undefined;
			lifetime.abort();
			for (const discovery of providers) discovery.dispose();
			stopped = true;
		});
	};
}
