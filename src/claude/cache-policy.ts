import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";

export interface ClaudeCachePolicy {
	readonly retention: NonNullable<StreamOptions["cacheRetention"]>;
	readonly control: Readonly<{ type: "ephemeral"; ttl?: "1h" }> | undefined;
	readonly tools: boolean;
}

/** Pi AI 1.5.0 anthropic-messages resolveCacheRetention/getCacheControl.
 * Keep this pinned to the native-delegate differential tests when upgrading Pi.
 * Use native env lookup, including falsy overrides and Bun sandbox fallback.
 */
/** Mirrors Pi's scoped/process/Bun fallback without a loader-incompatible subpath import. */
function cacheEnvironment(options: StreamOptions): string | undefined {
	const value = options.env?.PI_CACHE_RETENTION || process.env.PI_CACHE_RETENTION;
	if (value || !process.versions.bun || Object.keys(process.env).length > 0) return value;
	try {
		return readFileSync("/proc/self/environ", "utf8").split("\0")
			.find((entry) => entry.startsWith("PI_CACHE_RETENTION="))?.slice("PI_CACHE_RETENTION=".length);
	} catch { return undefined; }
}
export function resolveClaudeCachePolicy(options: StreamOptions, model: Model<Api>): ClaudeCachePolicy {
	const retention = options.cacheRetention || (cacheEnvironment(options) === "long" ? "long" : "short");
	const compat = model.compat as { supportsLongCacheRetention?: boolean; supportsCacheControlOnTools?: boolean } | undefined;
	return {
		retention,
		control: retention === "none" ? undefined : {
			type: "ephemeral",
			...(retention === "long" && compat?.supportsLongCacheRetention !== false ? { ttl: "1h" as const } : {}),
		},
		tools: compat?.supportsCacheControlOnTools !== false,
	};
}
