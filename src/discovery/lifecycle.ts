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
		function notify(state: DiscoveryState) {
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
				allowNetwork: !process.env.PI_OFFLINE, force: true, signal: lifetime.signal }).catch(() => {
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
