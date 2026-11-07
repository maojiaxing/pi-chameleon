import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSnapshotRepository, type SnapshotFileIO } from "../src/discovery/snapshot.ts";
import type { CatalogRecord, CatalogSnapshot, DiscoveryAccess } from "../src/discovery/types.ts";

const claude = "chameleon-claude";
const codex = "chameleon-codex";
const access: DiscoveryAccess = {
	baseUrl: "https://synthetic-relay.invalid/v1",
	apiKey: "SYNTHETIC_EFFECTIVE_KEY",
	headers: { "X-Tenant": "SYNTHETIC_TENANT" },
};
const first: CatalogSnapshot = { checkedAt: 1_700_000_000_000, records: [{ id: "relay/Claude-Exact" }] };

async function withDirectory(run: (directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "chameleon-safe-snapshot-"));
	try {
		await run(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("success replaces the one catalog, suspension preserves it, and an empty success resets suspension", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		await repository.suspend(claude, identity);
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: first, suspended: true });
		const replacement: CatalogSnapshot = { checkedAt: first.checkedAt + 1, records: [{ id: "new-only" }] };
		await repository.saveSuccess(claude, identity, replacement);
		assert.deepEqual(await repository.read(claude, identity), { snapshot: replacement, suspended: false });
		await repository.suspend(claude, identity);
		const empty: CatalogSnapshot = { checkedAt: first.checkedAt + 2, records: [] };
		await repository.saveSuccess(claude, identity, empty);
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: empty, suspended: false });
		assert.equal((await readdir(directory)).length, 2, "only one catalog and its local identity key survive replacement");
	});
});

test("serialized bytes contain only validated discovery facts, not runtime objects or synthetic secrets", async () => {
	await withDirectory(async (directory) => {
		const secret = "SYNTHETIC_RAW_AND_OVERRIDE_SECRET";
		const input: CatalogRecord["input"] = ["text", "image"];
		const record = {
			id: "relay/ExactCase", name: "Relay label", contextWindow: 32768, maxTokens: 4096,
			input, reasoning: false,
			thinkingLevelMap: { high: "high", xhigh: null, authorization: secret },
			compat: { supportsTemperature: false, forceAdaptiveThinking: true, headers: { Authorization: secret } },
			cost: { input: 0, output: 1.25, cacheRead: 0, cacheWrite: 0, raw: secret },
			baseUrl: access.baseUrl, apiKey: access.apiKey, headers: access.headers,
			raw: { response: secret }, userOverrides: { name: secret }, token: secret,
			toJSON: () => ({ id: "relay/ExactCase", raw: secret }),
		};
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, { checkedAt: first.checkedAt, records: [record], raw: secret } as CatalogSnapshot);
		const safe: CatalogSnapshot = {
			checkedAt: first.checkedAt,
			records: [{
				id: "relay/ExactCase", name: "Relay label", contextWindow: 32768, maxTokens: 4096,
				input: ["text", "image"], reasoning: false,
				thinkingLevelMap: { high: "high", xhigh: null },
				compat: { supportsTemperature: false, forceAdaptiveThinking: true },
				cost: { input: 0, output: 1.25, cacheRead: 0, cacheWrite: 0 },
			}],
		};
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: safe, suspended: false });
		for (const name of await readdir(directory)) {
			const bytes = await readFile(join(directory, name));
			for (const forbidden of [secret, access.baseUrl, access.apiKey!, "SYNTHETIC_TENANT", "userOverrides", "Authorization"]) {
				assert.equal(bytes.includes(Buffer.from(forbidden)), false, `persisted bytes must exclude ${forbidden}`);
			}
		}
	});
});

test("identity tracks effective access semantics but never leaks the raw credentials", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		assert.equal(await repository.identity(access), await repository.identity(access));
		assert.equal(
			await repository.identity(access),
			await repository.identity({ ...access, baseUrl: "https://SYNTHETIC-RELAY.invalid/v1///" }),
			"same endpoint in another casing with trailing slashes keeps the catalog",
		);
		assert.equal(
			await repository.identity(access),
			await repository.identity({ ...access, headers: { "x-tenant": "SYNTHETIC_TENANT" } }),
			"header names are canonicalized",
		);
		assert.notEqual(await repository.identity(access), await repository.identity({ ...access, apiKey: "SYNTHETIC_ROTATED_KEY" }));
		assert.notEqual(await repository.identity(access), await repository.identity({ ...access, baseUrl: "https://other-synthetic-relay.invalid/v1" }));
		assert.notEqual(
			await repository.identity(access),
			await repository.identity({ ...access, headers: { "X-Tenant": "SYNTHETIC_OTHER_TENANT" } }),
			"an authorization-relevant header value changes identity",
		);
		const digest = await repository.identity(access);
		assert.match(digest, /^[0-9a-f]{64}$/);
		for (const name of await readdir(directory)) {
			const bytes = await readFile(join(directory, name));
			assert.equal(bytes.includes(Buffer.from(access.apiKey!)), false, "identity key material must never contain raw credentials");
		}
	});
});

test("each provider keeps its own single snapshot and never imports another identity", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const claudeIdentity = await repository.identity(access);
		const codexIdentity = await repository.identity({ ...access, baseUrl: "https://synthetic-codex-relay.invalid/v1" });
		await repository.saveSuccess(claude, claudeIdentity, first);
		assert.deepEqual(await repository.read(codex, codexIdentity), { suspended: false });
		assert.deepEqual(
			await repository.read(claude, codexIdentity),
			{ suspended: false },
			"a snapshot saved under one identity is not readable under another",
		);
		const codexSnapshot: CatalogSnapshot = { checkedAt: first.checkedAt + 5, records: [{ id: "codex/only" }] };
		await repository.saveSuccess(codex, codexIdentity, codexSnapshot);
		assert.deepEqual(await repository.read(claude, claudeIdentity), { snapshot: first, suspended: false });
		assert.deepEqual(await repository.read(codex, codexIdentity), { snapshot: codexSnapshot, suspended: false });
	});
});

test("untrusted, old, oversized, or malformed persisted envelopes are unavailable", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
		assert.equal(files.length, 1);
		const file = join(directory, files[0]);
		const original = JSON.parse(await readFile(file, "utf8"));
		const corrupt: unknown[] = [
			{ ...original, suspended: "false" },
			{ ...original, schemaVersion: 0 },
			{ ...original, provider: codex },
			{ ...original, snapshot: { checkedAt: -1, records: [{ id: "wrong" }] } },
			{ ...original, snapshot: { checkedAt: first.checkedAt, records: [{ id: "", maxTokens: 0 }] } },
			{ ...original, snapshot: { checkedAt: first.checkedAt, records: "not-a-list" } },
			null, [], { provider: claude, records: first.records },
		];
		for (const value of corrupt) {
			await writeFile(file, JSON.stringify(value));
			assert.deepEqual(await repository.read(claude, identity), { suspended: false }, "corrupt data cannot become an applicable catalog");
		}
		await writeFile(file, "{");
		assert.deepEqual(await repository.read(claude, identity), { suspended: false });
		await writeFile(file, JSON.stringify({ ...original, padding: "x".repeat(2 * 1024 * 1024) }));
		assert.deepEqual(await repository.read(claude, identity), { suspended: false }, "bounded reads reject oversized envelopes");
		await writeFile(file, JSON.stringify(original));
		assert.deepEqual(await repository.read(claude, ""), { suspended: false }, "an unconfirmed identity cannot restore");
		await rm(file);
		assert.deepEqual(await repository.read(claude, identity), { suspended: false });
	});
});

test("partial writes and rename failures report safe codes without damaging the prior catalog", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		const replacement: CatalogSnapshot = { checkedAt: first.checkedAt + 3, records: [{ id: "new-only" }] };
		const faults: Partial<SnapshotFileIO>[] = [
			{ writeFile: async (path, bytes, options) => {
				await writeFile(path, String(bytes).slice(0, 12), options);
				throw new Error(`SYNTHETIC_WRITE_SECRET ${path}`);
			} },
			{ rename: async (path) => { throw new Error(`SYNTHETIC_RENAME_SECRET ${path}`); } },
		];
		for (const io of faults) {
			const faulty = createSnapshotRepository({ directory, io });
			await assert.rejects(faulty.saveSuccess(claude, identity, replacement), (error: unknown) => {
				assert.equal(error instanceof Error, true);
				const safe = error as Error & { code: string };
				assert.equal(safe.code, "SNAPSHOT_WRITE_FAILED");
				assert.equal(safe.message, safe.code);
				assert.equal(JSON.stringify(safe).includes(directory), false);
				assert.equal(String(safe).includes("SYNTHETIC"), false);
				return true;
			});
			assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: first, suspended: false });
			assert.equal((await readdir(directory)).length, 2, "failed writes leave no historical or partial files");
		}
	});
});

test("aborted or superseded work cannot replace or suspend the last successful catalog", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		const replacement: CatalogSnapshot = { checkedAt: first.checkedAt + 4, records: [{ id: "stale-only" }] };
		const alreadyAborted = new AbortController();
		alreadyAborted.abort("SYNTHETIC_ABORT_REASON");
		await assert.rejects(repository.saveSuccess(claude, identity, replacement, { signal: alreadyAborted.signal }), { code: "SNAPSHOT_CANCELLED" });
		await assert.rejects(repository.suspend(claude, identity, { isCurrent: () => false }), { code: "SNAPSHOT_CANCELLED" });
		for (const kind of ["abort", "generation"] as const) {
			const controller = new AbortController();
			let current = true;
			const guarded = createSnapshotRepository({ directory, io: {
				writeFile: async (path, bytes, options) => {
					await writeFile(path, bytes, options);
					if (kind === "abort") controller.abort("SYNTHETIC_LATE_ABORT");
					else current = false;
				},
			} });
			await assert.rejects(guarded.saveSuccess(claude, identity, replacement, { signal: controller.signal, isCurrent: () => current }), {
				code: "SNAPSHOT_CANCELLED", message: "SNAPSHOT_CANCELLED",
			});
			assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: first, suspended: false });
			assert.equal((await readdir(directory)).length, 2);
		}
	});
});

test("same-provider writes across repository instances are serialized rather than overtaking one another", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => { enter = resolve; });
		const released = new Promise<void>((resolve) => { release = resolve; });
		let firstCommitted = false;
		const slow = createSnapshotRepository({ directory, io: {
			writeFile: async (path, bytes, options) => {
				await writeFile(path, bytes, options);
				enter();
				await released;
			},
			rename: async (source, destination) => {
				await rename(source, destination);
				firstCommitted = true;
			},
		} });
		// This external storage adapter refuses overlapping writers, not private repository calls.
		const next = createSnapshotRepository({ directory, io: {
			mkdir: (path, options) => firstCommitted ? mkdir(path, options)
				: Promise.reject(new Error("SYNTHETIC_OVERLAPPING_WRITER")),
		} });
		const older: CatalogSnapshot = { checkedAt: first.checkedAt + 1, records: [{ id: "older" }] };
		const latest: CatalogSnapshot = { checkedAt: first.checkedAt + 2, records: [{ id: "latest" }] };
		const pending = slow.saveSuccess(claude, identity, older);
		await entered;
		const newest = next.saveSuccess(claude, identity, latest);
		release();
		await Promise.all([pending, newest]);
		assert.deepEqual(await repository.read(claude, identity), { snapshot: latest, suspended: false });
		assert.equal((await readdir(directory)).length, 2);
	});
});

test("concurrent first identities across instances share one complete local key", async () => {
	await withDirectory(async (directory) => {
		const repositories = Array.from({ length: 24 }, () => createSnapshotRepository({ directory }));
		const digests = await Promise.all(repositories.map((repository) => repository.identity(access)));
		const restarted = createSnapshotRepository({ directory });
		const recovered = await restarted.identity(access);
		assert.deepEqual([...new Set(digests)], [recovered], "no identity can use an empty or partially generated key");
		await repositories[0].saveSuccess(claude, digests[0], first);
		assert.deepEqual(await restarted.read(claude, recovered), { snapshot: first, suspended: false });
		const keys = (await readdir(directory)).filter((name) => !name.endsWith(".json"));
		assert.equal(keys.length, 1);
		assert.equal((await readFile(join(directory, keys[0]))).length, 32);
		if (process.platform !== "win32") {
			assert.equal((await stat(directory)).mode & 0o777, 0o700);
			assert.equal((await stat(join(directory, keys[0]))).mode & 0o777, 0o600);
		}
	});
});

test("an invalid local key is not silently used or replaced with another key", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		await repository.identity(access);
		const key = join(directory, (await readdir(directory))[0]);
		await writeFile(key, "");
		await assert.rejects(repository.identity(access), { code: "SNAPSHOT_IDENTITY_FAILED", message: "SNAPSHOT_IDENTITY_FAILED" });
		assert.equal((await readFile(key)).length, 0, "corrupt key material must not be regenerated behind an existing snapshot");
	});
});

test("every public error contains only a safe code, even when inputs or storage throw secrets", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		const hostileSnapshot = {
			get checkedAt(): number { throw new Error(`SYNTHETIC_GETTER_SECRET ${directory}`); },
			records: first.records,
		};
		await assert.rejects(repository.saveSuccess(claude, identity, hostileSnapshot), { code: "SNAPSHOT_INVALID", message: "SNAPSHOT_INVALID" });
		const unreadable = createSnapshotRepository({ directory, io: {
			readFile: async () => { throw new Error(`SYNTHETIC_KEY_READ_SECRET ${directory}`); },
		} });
		await assert.rejects(unreadable.identity(access), { code: "SNAPSHOT_IDENTITY_FAILED", message: "SNAPSHOT_IDENTITY_FAILED" });
		assert.deepEqual(await unreadable.read(claude, identity), { suspended: false });
		assert.equal(await repository.identity(access), identity, "a transient read failure never changes the key");
		const failedCleanup = createSnapshotRepository({ directory, io: {
			unlink: async () => { throw null; },
		} });
		await assert.rejects(failedCleanup.saveSuccess(claude, identity, first), { code: "SNAPSHOT_WRITE_FAILED", message: "SNAPSHOT_WRITE_FAILED" });
	});
});

test("suspension without a prior success is durable but does not fabricate a snapshot", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.suspend(claude, identity);
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { suspended: true });
	});
});

test("a complete successful catalog survives a new repository instance", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		const restored = createSnapshotRepository({ directory });
		assert.deepEqual(await restored.read(claude, await restored.identity(access)), {
			snapshot: first, suspended: false,
		});
	});
});
