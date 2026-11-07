import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
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

test("suspending a different identity preserves only the prior identity's successful catalog", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const previous = await repository.identity(access);
		const denied = await repository.identity({ ...access, apiKey: "SYNTHETIC_DENIED_IDENTITY" });
		await repository.saveSuccess(claude, previous, first);
		await repository.suspend(claude, denied);
		const restarted = createSnapshotRepository({ directory });
		assert.deepEqual(await restarted.read(claude, denied), { suspended: true });
		assert.deepEqual(await restarted.read(claude, previous), { snapshot: first, suspended: false });
		const empty: CatalogSnapshot = { checkedAt: first.checkedAt + 1, records: [] };
		await repository.saveSuccess(claude, denied, empty);
		assert.deepEqual(await restarted.read(claude, previous), { suspended: false }, "a real success replaces the single successful identity");
		assert.deepEqual(await restarted.read(claude, denied), { snapshot: empty, suspended: false });
	});
});

test("a durable verification claim blocks restart reuse until an ordinary failure releases it", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		assert.ok(repository.begin, "the public repository must admit jobs before network work");
		assert.ok(repository.release, "ordinary failures can end only their own verification claim");
		const token = await repository.begin(claude, identity);
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: first, suspended: true });
		await repository.release(claude, identity, { token });
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: first, suspended: false });
	});
});

test("successful claimed verification clears its barrier without resetting the durable revision", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		assert.ok(repository.begin);
		const token = await repository.begin(claude, identity);
		const replacement: CatalogSnapshot = { checkedAt: first.checkedAt + 20, records: [] };
		await repository.saveSuccess(claude, identity, replacement, { token });
		const restarted = createSnapshotRepository({ directory });
		assert.deepEqual(await restarted.read(claude, identity), { snapshot: replacement, suspended: false });
		assert.ok(restarted.begin);
		const next = await restarted.begin(claude, identity);
		assert.ok(BigInt(next.split(":")[0]) > BigInt(token.split(":")[0]), "success must not erase the fencing revision");
	});
});

function startSnapshotProcess(script: string, directory: string, mode: "old" | "new" | "legacy", identity: string) {
	let blocked!: (value: { token: string }) => void;
	let finish!: (value: { token: string; save: string; suspend?: string; release?: string }) => void;
	let rejectBlocked!: (error: Error) => void;
	let rejectDone!: (error: Error) => void;
	const ready = new Promise<{ token: string }>((resolve, reject) => { blocked = resolve; rejectBlocked = reject; });
	const done = new Promise<{ token: string; save: string; suspend?: string; release?: string }>((resolve, reject) => { finish = resolve; rejectDone = reject; });
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name];
	const child: ChildProcess = fork(script, [directory, mode, identity], {
		cwd: directory, env, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
	});
	const closed = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
	let completed = false;
	child.on("message", (message) => {
		if (!message || typeof message !== "object" || !("event" in message)) return;
		if (message.event === "blocked" && "token" in message && typeof message.token === "string") blocked({ token: message.token });
		if (message.event === "done" && "token" in message && typeof message.token === "string" && "save" in message && typeof message.save === "string") {
			completed = true;
			finish({ token: message.token, save: message.save,
				...("suspend" in message && typeof message.suspend === "string" ? { suspend: message.suspend } : {}),
				...("release" in message && typeof message.release === "string" ? { release: message.release } : {}),
			});
		}
	});
	const failed = () => { if (!completed) { const error = new Error("SYNTHETIC_CHILD_FAILED"); rejectBlocked(error); rejectDone(error); } };
	child.on("error", failed);
	child.on("exit", failed);
	// Both promises have rejection handlers even when a scenario uses only one of them.
	void ready.catch(() => {});
	void done.catch(() => {});
	return { child, ready, done, closed };
}

async function verifyCrossProcessFence(directory: string, differentIdentity: boolean, legacy = false) {
	const repository = createSnapshotRepository({ directory });
	const oldIdentity = await repository.identity(access);
	const newIdentity = differentIdentity ? await repository.identity({ ...access, apiKey: "SYNTHETIC_NEW_PROCESS_KEY" }) : oldIdentity;
	await repository.saveSuccess(claude, oldIdentity, first);
	const script = join(directory, "synthetic-fencing-job.mjs");
	await writeFile(script, `
		import { once } from "node:events";
		import { writeFile } from "node:fs/promises";
		import { createSnapshotRepository } from ${JSON.stringify(new URL("../src/discovery/snapshot.ts", import.meta.url).href)};
		const [directory, mode, identity] = process.argv.slice(2);
		const provider = "chameleon-claude";
		let token, paused = false;
		const repository = createSnapshotRepository({ directory, io: mode !== "new" ? {
			writeFile: async (path, bytes, options) => {
				await writeFile(path, bytes, options);
				const value = JSON.parse(String(bytes));
				if (!paused && value.pending === false && value.snapshot?.checkedAt === 1700000000001) {
					paused = true;
					token = value.token;
					process.send({ event: "blocked", token });
					await once(process, "message");
				}
			},
		} : undefined });
		try {
			if (mode !== "legacy") token = await repository.begin(provider, identity);
			let save = "saved", suspend, release;
			try { await repository.saveSuccess(provider, identity, {
				checkedAt: mode !== "new" ? 1700000000001 : 1700000000002,
				records: [{ id: mode !== "new" ? "synthetic-old" : "synthetic-new" }],
			}, mode === "legacy" ? undefined : { token }); } catch (error) { save = error.code; }
			if (mode !== "new") {
				suspend = "suspended";
				try { await repository.suspend(provider, identity, { token }); } catch (error) { suspend = error.code; }
				release = "released";
				try { await repository.release(provider, identity, { token }); } catch (error) { release = error.code; }
			}
			process.send({ event: "done", token, save, suspend, release });
		} finally { process.disconnect(); }
	`);
	const old = startSnapshotProcess(script, directory, legacy ? "legacy" : "old", oldIdentity);
	let next: ReturnType<typeof startSnapshotProcess> | undefined;
	try {
		const token1 = (await old.ready).token;
		next = startSnapshotProcess(script, directory, "new", newIdentity);
		const latest = await next.done;
		assert.equal(latest.save, "saved");
		assert.ok(BigInt(latest.token.split(":")[0]) > BigInt(token1.split(":")[0]));
		const expected = { snapshot: { checkedAt: first.checkedAt + 2, records: [{ id: "synthetic-new" }] }, suspended: false };
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, newIdentity), expected);
		old.child.send("resume");
		const stale = await old.done;
		assert.deepEqual([stale.save, stale.suspend, stale.release], ["SNAPSHOT_CANCELLED", "SNAPSHOT_CANCELLED", "SNAPSHOT_CANCELLED"]);
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, newIdentity), expected);
		if (differentIdentity) assert.deepEqual(await repository.read(claude, oldIdentity), { suspended: false });
	} finally {
		if (old.child.exitCode === null) old.child.kill();
		if (next && next.child.exitCode === null) next.child.kill();
		await Promise.all([old.closed, next?.closed]);
		await rm(script, { force: true });
	}
}

for (const differentIdentity of [false, true]) {
	test(`cross-process claims fence a late save, suspension and release for ${differentIdentity ? "different identities" : "the same identity"}`, { timeout: 20_000 }, async () => {
		await withDirectory((directory) => verifyCrossProcessFence(directory, differentIdentity));
	});
}

test("a legacy save claims before slow IO and cannot overtake a later process claim", { timeout: 20_000 }, async () => {
	await withDirectory((directory) => verifyCrossProcessFence(directory, true, true));
});

test("a failed permission-suspension commit stays blocked across restart and a later ordinary failure", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		assert.ok(repository.begin);
		const token = await repository.begin(claude, identity);
		const faulty = createSnapshotRepository({ directory, io: {
			rename: async () => { throw new Error("SYNTHETIC_401_COMMIT_SECRET"); },
		} });
		await assert.rejects(faulty.suspend(claude, identity, { token }), { code: "SNAPSHOT_WRITE_FAILED", message: "SNAPSHOT_WRITE_FAILED" });
		const restarted = createSnapshotRepository({ directory });
		assert.deepEqual(await restarted.read(claude, identity), { snapshot: first, suspended: true });
		assert.ok(restarted.begin);
		assert.ok(restarted.release);
		const retry = await restarted.begin(claude, identity);
		await restarted.release(claude, identity, { token: retry });
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: first, suspended: true },
			"an unresolved earlier permission check requires a complete success, not an ordinary failure, to unblock");
		const success = await restarted.begin(claude, identity);
		const empty: CatalogSnapshot = { checkedAt: first.checkedAt + 30, records: [] };
		await restarted.saveSuccess(claude, identity, empty, { token: success });
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: empty, suspended: false });
	});
});

test("a failed claimed save preserves success behind its pending barrier until ordinary failure release", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		assert.ok(repository.begin);
		assert.ok(repository.release);
		const token = await repository.begin(claude, identity);
		const faulty = createSnapshotRepository({ directory, io: {
			writeFile: async (path, bytes, options) => {
				await writeFile(path, String(bytes).slice(0, 12), options);
				throw new Error("SYNTHETIC_PARTIAL_SAVE_SECRET");
			},
		} });
		await assert.rejects(faulty.saveSuccess(claude, identity, { checkedAt: first.checkedAt + 40, records: [] }, { token }), {
			code: "SNAPSHOT_WRITE_FAILED", message: "SNAPSHOT_WRITE_FAILED",
		});
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: first, suspended: true });
		await repository.release(claude, identity, { token });
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: first, suspended: false });
	});
});

test("release of an ordinary failure never clears a known permission suspension", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		await repository.suspend(claude, identity);
		assert.ok(repository.begin);
		assert.ok(repository.release);
		const token = await repository.begin(claude, identity);
		await repository.release(claude, identity, { token });
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: first, suspended: true });
	});
});

test("a claimed suspension for a new identity keeps the prior successful identity record", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const previous = await repository.identity(access);
		const denied = await repository.identity({ ...access, apiKey: "SYNTHETIC_CLAIMED_DENIED_KEY" });
		await repository.saveSuccess(claude, previous, first);
		assert.ok(repository.begin);
		const token = await repository.begin(claude, denied);
		await repository.suspend(claude, denied, { token });
		const restarted = createSnapshotRepository({ directory });
		assert.deepEqual(await restarted.read(claude, denied), { suspended: true });
		assert.deepEqual(await restarted.read(claude, previous), { snapshot: first, suspended: false });
		assert.deepEqual(await restarted.read(claude, "f".repeat(64)), { suspended: false });
	});
});

test("a cancelled claimed save retains its barrier and its primary error despite cleanup failure", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		assert.ok(repository.begin);
		const token = await repository.begin(claude, identity);
		const controller = new AbortController();
		const faulty = createSnapshotRepository({ directory, io: {
			writeFile: async (path, bytes, options) => {
				await writeFile(path, bytes, options);
				controller.abort("SYNTHETIC_CANCEL_SECRET");
			},
			unlink: async () => { throw new Error("SYNTHETIC_CLEANUP_SECRET"); },
		} });
		await assert.rejects(faulty.saveSuccess(claude, identity, { checkedAt: first.checkedAt + 50, records: [] }, { token, signal: controller.signal }), {
			code: "SNAPSHOT_CANCELLED", message: "SNAPSHOT_CANCELLED",
		});
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: first, suspended: true });
	});
});

test("a late ordinary release cannot overwrite a completed permission suspension for its claim", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		assert.ok(repository.begin);
		const token = await repository.begin(claude, identity);
		let reached!: () => void;
		let resume!: () => void;
		const entered = new Promise<void>((resolve) => { reached = resolve; });
		const gate = new Promise<void>((resolve) => { resume = resolve; });
		const slowRelease = createSnapshotRepository({ directory, io: {
			writeFile: async (path, bytes, options) => {
				await writeFile(path, bytes, options);
				reached();
				await gate;
			},
		} });
		assert.ok(slowRelease.release);
		const released = slowRelease.release(claude, identity, { token });
		await entered;
		try { await repository.suspend(claude, identity, { token }); } finally { resume(); }
		await assert.rejects(released, { code: "SNAPSHOT_CANCELLED" });
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: first, suspended: true });
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

test("safe partial pricing and numeric tier facts survive snapshot restoration without raw fields", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		const snapshot: CatalogSnapshot = JSON.parse(`{"checkedAt":1700000000000,"records":[
			{"id":"gpt-5.4","cost":{"input":0,"tiers":[{"inputTokensAbove":272000,"input":5,"output":22.5,"cacheRead":0.5,"cacheWrite":0,"raw":"SYNTHETIC_TIER_SECRET"}],"authorization":"SYNTHETIC_COST_SECRET"}}
		]}`);
		await repository.saveSuccess(codex, identity, snapshot);
		assert.deepEqual(await createSnapshotRepository({ directory }).read(codex, identity), {
			suspended: false, snapshot: { checkedAt: first.checkedAt, records: [{ id: "gpt-5.4", cost: {
				input: 0, tiers: [{ inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }],
			} }] },
		});
		for (const name of await readdir(directory)) assert.doesNotMatch((await readFile(join(directory, name))).toString(), /SYNTHETIC_(TIER|COST)_SECRET/);
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

test("identity uses final case-insensitive header replacements and null deletions", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const canonical = await repository.identity({ ...access, headers: { "x-tenant": "final" } });
		assert.equal(await repository.identity({ ...access, headers: {
			"X-Tenant": "discarded", "x-tenant": "  final  ", "X-Removed": "discarded", "x-removed": null,
		} }), canonical);
		assert.equal(await repository.identity({ ...access, headers: { "X-Removed": null } }),
			await repository.identity({ ...access, headers: {} }));
	});
});

test("identity rejects every inadmissible endpoint rather than reusing a valid catalog", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		for (const baseUrl of [
			`${access.baseUrl}#SYNTHETIC_FRAGMENT`, `${access.baseUrl}?key=SYNTHETIC_QUERY`,
			"https://SYNTHETIC_USER:SYNTHETIC_PASSWORD@synthetic-relay.invalid/v1",
			"ftp://synthetic-relay.invalid/v1", "file:///SYNTHETIC_PATH", "not a URL",
		]) {
			await assert.rejects(repository.identity({ ...access, baseUrl }), {
				code: "SNAPSHOT_IDENTITY_FAILED", message: "SNAPSHOT_IDENTITY_FAILED",
			});
		}
		assert.deepEqual(await repository.read(claude, identity), { snapshot: first, suspended: false });
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

test("cleanup cannot report a committed catalog as failed", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		const replacement: CatalogSnapshot = { checkedAt: first.checkedAt + 9, records: [{ id: "committed" }] };
		const faulty = createSnapshotRepository({ directory, io: {
			unlink: async () => { throw new Error("SYNTHETIC_CLEANUP_SECRET"); },
		} });
		await faulty.saveSuccess(claude, identity, replacement);
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: replacement, suspended: false });
	});
});

test("cleanup preserves the primary cancellation and the preceding catalog", async () => {
	await withDirectory(async (directory) => {
		const repository = createSnapshotRepository({ directory });
		const identity = await repository.identity(access);
		await repository.saveSuccess(claude, identity, first);
		const controller = new AbortController();
		const faulty = createSnapshotRepository({ directory, io: {
			writeFile: async (path, bytes, options) => {
				await writeFile(path, bytes, options);
				controller.abort("SYNTHETIC_CANCEL_SECRET");
			},
			unlink: async () => { throw new Error("SYNTHETIC_CLEANUP_SECRET"); },
		} });
		await assert.rejects(faulty.saveSuccess(claude, identity, { checkedAt: first.checkedAt + 10, records: [] }, { signal: controller.signal }), {
			code: "SNAPSHOT_CANCELLED", message: "SNAPSHOT_CANCELLED",
		});
		assert.deepEqual(await createSnapshotRepository({ directory }).read(claude, identity), { snapshot: first, suspended: false });
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
		await failedCleanup.saveSuccess(claude, identity, first);
		assert.deepEqual(await repository.read(claude, identity), { snapshot: first, suspended: false });
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
