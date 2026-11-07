import { createHmac, randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
	CatalogRecord, CatalogSnapshot, ChameleonProviderId, DiscoveryAccess, OperationGuard,
	SnapshotRepository, SnapshotState,
} from "./types.ts";

export interface SnapshotFileIO {
	chmod(path: string, mode: number): Promise<void>;
	link(source: string, destination: string): Promise<void>;
	mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
	readFile(path: string, maxBytes: number): Promise<Uint8Array>;
	syncFile(path: string): Promise<void>;
	writeFile(path: string, bytes: string | Uint8Array, options: { flag: "wx"; mode: number }): Promise<void>;
	rename(source: string, destination: string): Promise<void>;
	unlink(path: string): Promise<void>;
}

export interface SnapshotRepositoryOptions {
	directory: string;
	/** Optional overrides only at the external file-storage boundary. */
	io?: Partial<SnapshotFileIO>;
}

export type SnapshotErrorCode = "SNAPSHOT_INVALID" | "SNAPSHOT_WRITE_FAILED" | "SNAPSHOT_CANCELLED" | "SNAPSHOT_IDENTITY_FAILED";
export class SnapshotRepositoryError extends Error {
	readonly code: SnapshotErrorCode;
	constructor(code: SnapshotErrorCode) {
		super(code);
		this.name = "SnapshotRepositoryError";
		this.code = code;
	}
}

const writes = new Map<string, Promise<void>>();
function serializeWrite<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const absolute = resolve(path);
	const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
	const result = (writes.get(key) ?? Promise.resolve()).then(operation);
	const settled = result.then(() => {}, () => {});
	writes.set(key, settled);
	void settled.then(() => { if (writes.get(key) === settled) writes.delete(key); });
	return result;
}

async function localIdentityKey(directory: string, io: SnapshotFileIO): Promise<Buffer> {
	await io.mkdir(directory, { recursive: true, mode: 0o700 });
	await io.chmod(directory, 0o700);
	const path = join(directory, "identity.key");
	try {
		await io.chmod(path, 0o600);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
		// Publish only a completely written key. link is exclusive across processes,
		// unlike rename, which could overwrite the winner of a first-use race.
		const temporary = join(directory, `.identity.${randomBytes(12).toString("hex")}.tmp`);
		try {
			await io.writeFile(temporary, randomBytes(32), { flag: "wx", mode: 0o600 });
			try {
				await io.link(temporary, path);
			} catch (error) {
				if (!hasCode(error, "EEXIST")) throw error;
			}
		} finally {
			try {
				await io.unlink(temporary);
			} catch (error) {
				if (!hasCode(error, "ENOENT")) throw error;
			}
		}
		await io.chmod(path, 0o600);
	}
	const key = Buffer.from(await io.readFile(path, 32));
	if (key.length !== 32) throw new SnapshotRepositoryError("SNAPSHOT_IDENTITY_FAILED");
	return key;
}

function hasCode(error: unknown, code: string): boolean {
	try {
		return typeof error === "object" && error !== null && "code" in error && error.code === code;
	} catch {
		return false;
	}
}

function checkGuard(guard?: OperationGuard): void {
	try {
		if (guard?.signal?.aborted || guard?.isCurrent?.() === false) throw new Error();
	} catch {
		throw new SnapshotRepositoryError("SNAPSHOT_CANCELLED");
	}
}

interface Envelope extends SnapshotState {
	schemaVersion: 1;
	provider: ChameleonProviderId;
	/** Active identity metadata and the single successful identity are distinct records. */
	identity: string;
	snapshotIdentity?: string;
	snapshotSuspended?: boolean;
	revision?: string;
	token?: string;
	pending?: boolean;
}

interface Claim extends Envelope {
	revision: string;
	token: string;
	pending: boolean;
}

const MAX_BYTES = 1024 * 1024;
const validProvider = (value: unknown): value is ChameleonProviderId => value === "chameleon-claude" || value === "chameleon-codex";
const validIdentity = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

async function syncFile(path: string): Promise<void> {
	const handle = await open(path, "r+");
	try { await handle.sync(); } finally { await handle.close(); }
}

async function boundedRead(path: string, maxBytes: number): Promise<Buffer> {
	const handle = await open(path, "r");
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > maxBytes) throw new Error("STORAGE_INVALID");
		const bytes = Buffer.alloc(maxBytes + 1);
		let size = 0;
		while (size < bytes.length) {
			const result = await handle.read(bytes, size, bytes.length - size, size);
			if (result.bytesRead === 0) break;
			size += result.bytesRead;
		}
		if (size > maxBytes) throw new Error("STORAGE_INVALID");
		return bytes.subarray(0, size);
	} finally {
		await handle.close();
	}
}

type ObjectFields = Record<string, unknown>;
const object = (value: unknown): value is ObjectFields => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const rate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const compatBooleans = [
	"supportsEagerToolInputStreaming", "supportsLongCacheRetention", "sendSessionAffinityHeaders",
	"supportsCacheControlOnTools", "supportsTemperature", "forceAdaptiveThinking", "allowEmptySignature",
	"supportsStrictTools", "supportsMidConvoEffort", "supportsMidConvoSystemMessages", "supportsMidConvoToolChanges",
	"supportsDeveloperRole", "supportsStrictMode", "supportsOpenAIGrammarTools", "supportsAdditionalTools",
	"supportsToolSearch", "supportsExplicitPromptCacheMode", "supportsMaxOutputTokens", "supportsStore",
	"supportsReasoningEffort", "supportsUsageInStreaming", "supportsFinishReason", "requiresToolResultName",
	"requiresAssistantAfterToolResult", "requiresThinkingAsText", "requiresReasoningContentOnAssistantMessages",
	"zaiToolStream", "supportsThinkingTokenBudget", "supportsMidConvoToolAdditions",
] as const;

function catalogSnapshot(value: unknown): CatalogSnapshot | undefined {
	if (!object(value) || !positive(value.checkedAt) || !Array.isArray(value.records) || value.records.length > 10_000) return;
	const records: CatalogRecord[] = [];
	for (const candidate of value.records) {
		if (!object(candidate) || !text(candidate.id)) return;
		const record: CatalogRecord = { id: candidate.id };
		if (candidate.name !== undefined) {
			if (!text(candidate.name)) return;
			record.name = candidate.name;
		}
		for (const field of ["contextWindow", "maxTokens"] as const) {
			if (candidate[field] !== undefined) {
				if (!positive(candidate[field])) return;
				record[field] = candidate[field];
			}
		}
		if (candidate.input !== undefined) {
			if (!Array.isArray(candidate.input) || candidate.input.length < 1 || candidate.input.length > 2
				|| !candidate.input.every((item) => item === "text" || item === "image")
				|| new Set(candidate.input).size !== candidate.input.length) return;
			record.input = [...candidate.input];
		}
		if (candidate.reasoning !== undefined) {
			if (typeof candidate.reasoning !== "boolean") return;
			record.reasoning = candidate.reasoning;
		}
		if (candidate.thinkingLevelMap !== undefined) {
			if (!object(candidate.thinkingLevelMap)) return;
			const map: NonNullable<CatalogRecord["thinkingLevelMap"]> = {};
			for (const level of thinkingLevels) {
				const effort = candidate.thinkingLevelMap[level];
				if (effort !== undefined) {
					if (effort !== null && (!text(effort) || !/^[a-z0-9_-]{1,64}$/i.test(effort))) return;
					map[level] = effort;
				}
			}
			record.thinkingLevelMap = map;
		}
		if (candidate.compat !== undefined) {
			if (!object(candidate.compat)) return;
			const compat: Record<string, boolean | string> = {};
			for (const flag of compatBooleans) {
				if (candidate.compat[flag] !== undefined) {
					if (typeof candidate.compat[flag] !== "boolean") return;
					compat[flag] = candidate.compat[flag];
				}
			}
			if (candidate.compat.sessionAffinityFormat !== undefined) {
				const format = candidate.compat.sessionAffinityFormat;
				if (format !== "openai" && format !== "openai-nosession" && format !== "openrouter") return;
				compat.sessionAffinityFormat = format;
			}
			record.compat = compat;
		}
		if (candidate.cost !== undefined) {
			if (!object(candidate.cost)) return;
			const cost: NonNullable<CatalogRecord["cost"]> = {};
			for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
				const value = candidate.cost[field];
				if (value !== undefined) {
					if (!rate(value)) return;
					cost[field] = value;
				}
			}
			if (candidate.cost.tiers !== undefined) {
				if (!Array.isArray(candidate.cost.tiers) || candidate.cost.tiers.length > 100) return;
				cost.tiers = [];
				for (const tier of candidate.cost.tiers) {
					if (!object(tier)) return;
					const { inputTokensAbove, input, output, cacheRead, cacheWrite } = tier;
					if (!rate(inputTokensAbove) || !rate(input) || !rate(output) || !rate(cacheRead) || !rate(cacheWrite)) return;
					cost.tiers.push({ inputTokensAbove, input, output, cacheRead, cacheWrite });
				}
			}
			record.cost = cost;
		}
		records.push(record);
	}
	return { checkedAt: value.checkedAt, records };
}

/** The repository stores only discovery facts, never the access used to discover them. */
export function createSnapshotRepository(options: SnapshotRepositoryOptions): SnapshotRepository {
	const io: SnapshotFileIO = {
		chmod, link, mkdir, readFile: boundedRead, syncFile, writeFile, rename, unlink, ...options.io,
	};
	const file = (provider: ChameleonProviderId) => join(options.directory, `${provider}.json`);
	async function locked<T>(provider: ChameleonProviderId, guard: OperationGuard | undefined, operation: () => Promise<T>): Promise<T> {
		checkGuard(guard);
		if (!validProvider(provider)) throw new SnapshotRepositoryError("SNAPSHOT_INVALID");
		const path = `${file(provider)}.lock`;
		return serializeWrite(path, async () => {
			let handle: Awaited<ReturnType<typeof open>> | undefined;
			try {
				await io.mkdir(options.directory, { recursive: true, mode: 0o700 });
				// Exclusive creation is a cross-process mutex, held only for metadata/rename.
				// Never evict a live lock by age: a stalled holder must not lose its critical section.
				for (let attempt = 0; attempt < 200; attempt++) {
					checkGuard(guard);
					try { handle = await open(path, "wx", 0o600); break; } catch (error) {
						if (!hasCode(error, "EEXIST")) throw error;
						await delay(10);
					}
				}
				if (!handle) throw new SnapshotRepositoryError("SNAPSHOT_WRITE_FAILED");
				checkGuard(guard);
				return await operation();
			} catch (error) {
				if (error instanceof SnapshotRepositoryError) throw error;
				throw new SnapshotRepositoryError("SNAPSHOT_WRITE_FAILED");
			} finally {
				if (handle) {
					try { await handle.close(); } catch { /* Cleanup cannot replace the primary outcome. */ }
					try { await unlink(path); } catch { /* A residual lock fails closed, never gets age-evicted. */ }
				}
			}
		});
	}
	async function identity(access: DiscoveryAccess): Promise<string> {
		try {
			const url = new URL(access.baseUrl);
			if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
				throw new SnapshotRepositoryError("SNAPSHOT_IDENTITY_FAILED");
			}
			const key = await localIdentityKey(options.directory, io);
			const baseUrl = url.toString().replace(/\/+$/, "");
			const effective = new Headers();
			for (const [name, value] of Object.entries(access.headers ?? {})) {
				if (value === null) effective.delete(name);
				else effective.set(name, value);
			}
			const headers = [...effective.entries()].sort(([left], [right]) => left.localeCompare(right));
			return createHmac("sha256", key).update(JSON.stringify([baseUrl, access.apiKey ?? null, headers])).digest("hex");
		} catch {
			throw new SnapshotRepositoryError("SNAPSHOT_IDENTITY_FAILED");
		}
	}
	async function load(provider: ChameleonProviderId, guard?: OperationGuard, strict = false): Promise<Envelope | undefined> {
		try {
			const value: unknown = JSON.parse(Buffer.from(await io.readFile(file(provider), MAX_BYTES)).toString("utf8"));
			checkGuard(guard);
			if (!object(value) || value.schemaVersion !== 1 || value.provider !== provider || !validIdentity(value.identity)
				|| typeof value.suspended !== "boolean") return;
			const envelope: Envelope = { schemaVersion: 1, provider, identity: value.identity, suspended: value.suspended };
			if (value.revision !== undefined || value.token !== undefined || value.pending !== undefined) {
				if (typeof value.revision !== "string" || !/^[1-9][0-9]{0,127}$/.test(value.revision)
					|| typeof value.token !== "string" || !value.token.startsWith(`${value.revision}:`)
					|| !/^[1-9][0-9]{0,127}:[0-9a-f]{32}$/.test(value.token)
					|| typeof value.pending !== "boolean") return;
				envelope.revision = value.revision;
				envelope.token = value.token;
				envelope.pending = value.pending;
			}
			if (value.snapshot !== undefined) {
				const snapshot = catalogSnapshot(value.snapshot);
				if (!snapshot || (value.snapshotIdentity !== undefined && !validIdentity(value.snapshotIdentity))
					|| (value.snapshotSuspended !== undefined && typeof value.snapshotSuspended !== "boolean")) return;
				envelope.snapshot = snapshot;
				envelope.snapshotIdentity = value.snapshotIdentity ?? value.identity;
				envelope.snapshotSuspended = value.snapshotSuspended ?? value.suspended;
			}
			return envelope;
		} catch (error) {
			if (error instanceof SnapshotRepositoryError) throw error;
			if (strict && !hasCode(error, "ENOENT")) throw new SnapshotRepositoryError("SNAPSHOT_WRITE_FAILED");
			return;
		}
	}
	async function read(provider: ChameleonProviderId, digest: string, guard?: OperationGuard): Promise<SnapshotState> {
		checkGuard(guard);
		if (!validProvider(provider) || !validIdentity(digest)) return { suspended: false };
		try {
			return await locked(provider, guard, async () => {
				const envelope = await load(provider, guard);
				if (!envelope) return { suspended: false };
				if (envelope.snapshotIdentity === digest && envelope.snapshot) {
					return { snapshot: envelope.snapshot, suspended: Boolean(envelope.snapshotSuspended
						|| (envelope.identity === digest && (envelope.suspended || envelope.pending))) };
				}
				return { suspended: envelope.identity === digest && Boolean(envelope.suspended || envelope.pending) };
			});
		} catch (error) {
			if (error instanceof SnapshotRepositoryError && error.code === "SNAPSHOT_CANCELLED") throw error;
			return { suspended: false };
		}
	}
	async function removeTemporary(path: string): Promise<void> {
		try { await io.unlink(path); } catch { /* Cleanup never changes a commit or its primary failure. */ }
	}
	async function prepare(provider: ChameleonProviderId, state: Envelope, guard?: OperationGuard): Promise<string> {
		checkGuard(guard);
		const temporary = `${file(provider)}.${randomBytes(12).toString("hex")}.tmp`;
		try {
			const bytes = JSON.stringify(state);
			if (Buffer.byteLength(bytes) > MAX_BYTES) throw new SnapshotRepositoryError("SNAPSHOT_INVALID");
			await io.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
			await io.syncFile(temporary);
			checkGuard(guard);
			return temporary;
		} catch (error) {
			await removeTemporary(temporary);
			if (error instanceof SnapshotRepositoryError) throw error;
			throw new SnapshotRepositoryError("SNAPSHOT_WRITE_FAILED");
		}
	}
	/** Caller already holds the cross-process lock. */
	async function commitLocked(provider: ChameleonProviderId, state: Envelope, guard?: OperationGuard): Promise<void> {
		const temporary = await prepare(provider, state, guard);
		try {
			checkGuard(guard);
			await io.rename(temporary, file(provider));
		} catch (error) {
			if (error instanceof SnapshotRepositoryError) throw error;
			throw new SnapshotRepositoryError("SNAPSHOT_WRITE_FAILED");
		} finally { await removeTemporary(temporary); }
	}
	function checkClaim(state: Envelope | undefined, digest: string, guard: OperationGuard): asserts state is Claim {
		checkGuard(guard);
		if (!guard.token || !state?.revision || state.identity !== digest || state.token !== guard.token || !state.pending) {
			throw new SnapshotRepositoryError("SNAPSHOT_CANCELLED");
		}
	}
	async function claim(provider: ChameleonProviderId, digest: string, guard?: OperationGuard): Promise<Claim> {
		checkGuard(guard);
		if (!validProvider(provider) || !validIdentity(digest)) throw new SnapshotRepositoryError("SNAPSHOT_INVALID");
		return locked(provider, guard, async () => {
			const previous = await load(provider, guard, true);
			const revision = (BigInt(previous?.revision ?? "0") + 1n).toString();
			if (revision.length > 128) throw new SnapshotRepositoryError("SNAPSHOT_INVALID");
			const state: Claim = {
				...previous, schemaVersion: 1, provider, identity: digest, revision,
				token: `${revision}:${randomBytes(16).toString("hex")}`, pending: true,
				suspended: Boolean(previous?.identity === digest && (previous.suspended || previous.pending)),
				...(previous?.snapshot ? { snapshotSuspended: Boolean(previous.snapshotSuspended
					|| (previous.snapshotIdentity === previous.identity && previous.pending)) } : {}),
			};
			await commitLocked(provider, state, guard);
			return state;
		});
	}
	async function updateClaim(
		provider: ChameleonProviderId, digest: string, guard: OperationGuard,
		update: (state: Claim) => Claim,
	): Promise<void> {
		const state = await locked(provider, guard, async () => {
			const current = await load(provider, guard, true);
			checkClaim(current, digest, guard);
			return update(current);
		});
		// Potentially slow external IO is outside the commit lock. The token stays fixed.
		const temporary = await prepare(provider, state, guard);
		try {
			await locked(provider, guard, async () => {
				const current = await load(provider, guard, true);
				checkClaim(current, digest, guard);
				checkGuard(guard);
				await io.rename(temporary, file(provider));
			});
		} finally { await removeTemporary(temporary); }
	}
	async function claimedGuard(provider: ChameleonProviderId, digest: string, guard?: OperationGuard): Promise<OperationGuard> {
		checkGuard(guard);
		if (!validProvider(provider) || !validIdentity(digest)) throw new SnapshotRepositoryError("SNAPSHOT_INVALID");
		if (guard?.token !== undefined) return { ...guard };
		const state = await claim(provider, digest, guard);
		return { ...guard, token: state.token };
	}
	return {
		identity, read,
		begin: async (provider, digest, guard) => (await claim(provider, digest, guard)).token,
		release: async (provider, digest, guard) => {
			await updateClaim(provider, digest, guard, (state) => ({ ...state, pending: false }));
		},
		saveSuccess: async (provider, digest, snapshot: CatalogSnapshot, guard) => {
			checkGuard(guard);
			let safe: CatalogSnapshot | undefined;
			try { safe = catalogSnapshot(snapshot); } catch { throw new SnapshotRepositoryError("SNAPSHOT_INVALID"); }
			if (!safe) throw new SnapshotRepositoryError("SNAPSHOT_INVALID");
			const save = async () => {
				const owner = await claimedGuard(provider, digest, guard);
				await updateClaim(provider, digest, owner, (state) => ({
					...state, snapshot: safe, snapshotIdentity: digest, snapshotSuspended: false, suspended: false, pending: false,
				}));
			};
			if (guard?.token !== undefined) await save();
			else await serializeWrite(`${file(provider)}.legacy`, save);
		},
		suspend: async (provider, digest, guard) => {
			const suspend = async () => {
				const owner = await claimedGuard(provider, digest, guard);
				await updateClaim(provider, digest, owner, (state) => ({
					...state, suspended: true, pending: false,
					...(state.snapshot ? { snapshotSuspended: state.snapshotIdentity === digest || state.snapshotSuspended } : {}),
				}));
			};
			if (guard?.token !== undefined) await suspend();
			else await serializeWrite(`${file(provider)}.legacy`, suspend);
		},
	};
}
