import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSnapshotRepository } from "../src/discovery/snapshot.ts";

const provider = "chameleon-codex";
const access = { baseUrl: "https://synthetic-storage.invalid/v1", apiKey: "SYNTHETIC_STORAGE_KEY" };
const snapshot = { checkedAt: 123, records: [{ id: "gpt-original" }] };
async function directories(run: (cache: string, outside: string) => Promise<void>) {
	const cache = await mkdtemp(join(tmpdir(), "chameleon-private-cache-"));
	const outside = await mkdtemp(join(tmpdir(), "chameleon-external-target-"));
	try { await run(cache, outside); } finally {
		await rm(cache, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
}

const exec = promisify(execFile);

test("Windows refuses an Everyone-readable key even after ordinary chmod", { skip: process.platform !== "win32" }, async () => {
	await directories(async (cache) => {
		const repository = createSnapshotRepository({ directory: cache });
		await repository.identity(access);
		const path = join(cache, "identity.key");
		await exec("icacls.exe", [path, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
		const acl = await exec("icacls.exe", [path], { windowsHide: true });
		assert.match(acl.stdout, /(?:Everyone|S-1-1-0)/);
		await assert.rejects(repository.identity(access), { code: "SNAPSHOT_IDENTITY_FAILED", message: "SNAPSHOT_IDENTITY_FAILED" });
	});
});

test("Windows refuses a snapshot with an explicit foreign-readable DACL", { skip: process.platform !== "win32" }, async () => {
	await directories(async (cache) => {
		const repository = createSnapshotRepository({ directory: cache });
		const identity = await repository.identity(access);
		await repository.saveSuccess(provider, identity, snapshot);
		await exec("icacls.exe", [join(cache, `${provider}.json`), "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
		assert.deepEqual(await repository.read(provider, identity), { suspended: false });
	});
});

test("a key symlink is never accepted or used to alter its external target", async () => {
	await directories(async (cache, outside) => {
		const target = join(outside, "external.key");
		const bytes = Buffer.alloc(32, 7);
		await writeFile(target, bytes);
		await symlink(target, join(cache, "identity.key"), "file");
		await assert.rejects(createSnapshotRepository({ directory: cache }).identity(access), {
			code: "SNAPSHOT_IDENTITY_FAILED", message: "SNAPSHOT_IDENTITY_FAILED",
		});
		assert.deepEqual(await readFile(target), bytes);
	});
});

test("a snapshot symlink cannot restore forged models outside the private cache", async () => {
	await directories(async (cache, outside) => {
		const repository = createSnapshotRepository({ directory: cache });
		const identity = await repository.identity(access);
		await repository.saveSuccess(provider, identity, snapshot);
		const path = join(cache, `${provider}.json`);
		const envelope = JSON.parse(await readFile(path, "utf8"));
		envelope.snapshot = { checkedAt: 456, records: [{ id: "gpt-external-forged" }] };
		const target = join(outside, "forged.json");
		await writeFile(target, JSON.stringify(envelope));
		await rm(path);
		await symlink(target, path, "file");
		assert.deepEqual(await repository.read(provider, identity), { suspended: false });
		await assert.rejects(repository.saveSuccess(provider, identity, snapshot), { code: "SNAPSHOT_WRITE_FAILED" });
		assert.equal(JSON.parse(await readFile(target, "utf8")).snapshot.checkedAt, 456);
	});
});

test("a cache root junction or directory symlink never writes into its external target", async () => {
	await directories(async (cache, outside) => {
		const alias = join(cache, "cache-alias");
		await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
		try {
			await assert.rejects(createSnapshotRepository({ directory: alias }).identity(access), {
				code: "SNAPSHOT_IDENTITY_FAILED", message: "SNAPSHOT_IDENTITY_FAILED",
			});
			await assert.rejects(readFile(join(outside, "identity.key")), { code: "ENOENT" });
		} finally { await rm(alias, { force: true }); }
	});
});

test("a private Windows catalog survives repeated identity checks, commits and a fresh repository", { skip: process.platform !== "win32" }, async () => {
	await directories(async (cache) => {
		const repository = createSnapshotRepository({ directory: cache });
		const identity = await repository.identity(access);
		assert.equal(await repository.identity(access), identity);
		await repository.saveSuccess(provider, identity, snapshot);
		await repository.suspend(provider, identity);
		assert.deepEqual(await repository.read(provider, identity), { snapshot, suspended: true });
		const recovered = createSnapshotRepository({ directory: cache });
		assert.equal(await recovered.identity(access), identity);
		assert.deepEqual(await recovered.read(provider, identity), { snapshot, suspended: true });
		await recovered.saveSuccess(provider, identity, { checkedAt: 456, records: [] });
		assert.deepEqual(await repository.read(provider, identity), { snapshot: { checkedAt: 456, records: [] }, suspended: false });
	});
});
