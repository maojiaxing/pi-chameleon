import { createHmac, randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
	CatalogRecord, CatalogSnapshot, ChameleonProviderId, DiscoveryAccess, OperationGuard,
	SnapshotRepository, SnapshotState,
} from "./types.ts";

export interface SnapshotFileIO {
	chmod(path: string, mode: number): Promise<void>;
	link(source: string, destination: string): Promise<void>;
	mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
	readFile(path: string, maxBytes: number): Promise<Uint8Array>;
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
function serializeWrite(path: string, operation: () => Promise<void>): Promise<void> {
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
	identity: string;
}

const MAX_BYTES = 1024 * 1024;
const validProvider = (value: unknown): value is ChameleonProviderId => value === "chameleon-claude" || value === "chameleon-codex";
const validIdentity = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

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
			const { input, output, cacheRead, cacheWrite } = candidate.cost;
			if (!rate(input) || !rate(output) || !rate(cacheRead) || !rate(cacheWrite)) return;
			record.cost = { input, output, cacheRead, cacheWrite };
		}
		records.push(record);
	}
	return { checkedAt: value.checkedAt, records };
}

/** The repository stores only discovery facts, never the access used to discover them. */
export function createSnapshotRepository(options: SnapshotRepositoryOptions): SnapshotRepository {
	const io: SnapshotFileIO = {
		chmod, link, mkdir, readFile: boundedRead, writeFile, rename, unlink, ...options.io,
	};
	const file = (provider: ChameleonProviderId) => join(options.directory, `${provider}.json`);
	async function identity(access: DiscoveryAccess): Promise<string> {
		try {
			const key = await localIdentityKey(options.directory, io);
			const url = new URL(access.baseUrl);
			url.hash = "";
			const baseUrl = url.toString().replace(/\/+$/, "");
			const headers = Object.entries(access.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])
				.sort(([left], [right]) => String(left).localeCompare(String(right)));
			return createHmac("sha256", key).update(JSON.stringify([baseUrl, access.apiKey ?? null, headers])).digest("hex");
		} catch {
			throw new SnapshotRepositoryError("SNAPSHOT_IDENTITY_FAILED");
		}
	}
	async function read(provider: ChameleonProviderId, digest: string, guard?: OperationGuard): Promise<SnapshotState> {
		checkGuard(guard);
		if (!validProvider(provider) || !validIdentity(digest)) return { suspended: false };
		try {
			const envelope: unknown = JSON.parse(Buffer.from(await io.readFile(file(provider), MAX_BYTES)).toString("utf8"));
			checkGuard(guard);
			if (!object(envelope) || envelope.schemaVersion !== 1 || envelope.provider !== provider || envelope.identity !== digest
				|| typeof envelope.suspended !== "boolean") return { suspended: false };
			if (envelope.snapshot === undefined) return { suspended: envelope.suspended };
			const snapshot = catalogSnapshot(envelope.snapshot);
			return snapshot ? { snapshot, suspended: envelope.suspended } : { suspended: false };
		} catch (error) {
			if (error instanceof SnapshotRepositoryError) throw error;
			return { suspended: false };
		}
	}
	async function commit(provider: ChameleonProviderId, digest: string, state: SnapshotState, guard?: OperationGuard) {
		checkGuard(guard);
		if (!validProvider(provider) || !validIdentity(digest)) throw new SnapshotRepositoryError("SNAPSHOT_INVALID");
		const path = file(provider);
		const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
		try {
			await io.mkdir(options.directory, { recursive: true, mode: 0o700 });
			const envelope: Envelope = { schemaVersion: 1, provider, identity: digest, ...state };
			const bytes = JSON.stringify(envelope);
			if (Buffer.byteLength(bytes) > MAX_BYTES) throw new SnapshotRepositoryError("SNAPSHOT_INVALID");
			await io.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
			checkGuard(guard);
			await io.rename(temporary, path);
		} catch (error) {
			if (error instanceof SnapshotRepositoryError) throw error;
			throw new SnapshotRepositoryError("SNAPSHOT_WRITE_FAILED");
		} finally {
			try {
				await io.unlink(temporary);
			} catch (error) {
				if (!hasCode(error, "ENOENT")) throw new SnapshotRepositoryError("SNAPSHOT_WRITE_FAILED");
			}
		}
	}
	return {
		identity, read,
		saveSuccess: async (provider, digest, snapshot: CatalogSnapshot, guard) => {
			checkGuard(guard);
			let safe: CatalogSnapshot | undefined;
			try {
				safe = catalogSnapshot(snapshot);
			} catch {
				throw new SnapshotRepositoryError("SNAPSHOT_INVALID");
			}
			if (!safe || !validProvider(provider) || !validIdentity(digest)) throw new SnapshotRepositoryError("SNAPSHOT_INVALID");
			await serializeWrite(file(provider), () => commit(provider, digest, { snapshot: safe, suspended: false }, guard));
		},
		suspend: async (provider, digest, guard) => {
			checkGuard(guard);
			if (!validProvider(provider) || !validIdentity(digest)) throw new SnapshotRepositoryError("SNAPSHOT_INVALID");
			await serializeWrite(file(provider), async () => {
				const state = await read(provider, digest, guard);
				await commit(provider, digest, { ...state, suspended: true }, guard);
			});
		},
	};
}
