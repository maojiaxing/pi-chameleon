import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Internal safe storage error: callers expose only their existing repository codes. */
export class StorageSecurityError extends Error {
	constructor() { super("STORAGE_UNTRUSTED"); }
}
const samePath = (left: string, right: string) => process.platform === "win32"
	? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
const sameFile = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino;
const absent = (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";

/** Only the repository directory is a trust boundary; project/node_modules paths are irrelevant. */
export function createStorageSecurity(directory: string) {
	const root = resolve(directory);
	let pinned: Stats | undefined;
	function child(path: string): string {
		const absolute = resolve(path);
		if (!samePath(dirname(absolute), root)) throw new StorageSecurityError();
		return absolute;
	}
	async function assertRoot(missing = false): Promise<Stats | undefined> {
		let stat: Stats;
		try { stat = await lstat(root); } catch (error) {
			if (missing && absent(error) && !pinned) {
				// Before creation, validate the nearest existing parent without following aliases.
				let parent = dirname(root);
				while (true) {
					try {
						const existing = await lstat(parent);
						if (!existing.isDirectory() || existing.isSymbolicLink() || !samePath(await realpath(parent), parent)) throw new StorageSecurityError();
						return;
					} catch (parentError) {
						if (!absent(parentError) || parent === dirname(parent)) throw new StorageSecurityError();
						parent = dirname(parent);
					}
				}
			}
			throw error;
		}
		if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(root), root)
			|| (pinned && !sameFile(pinned, stat))) throw new StorageSecurityError();
		pinned ??= stat;
		return stat;
	}
	async function ensureDirectory(create = () => mkdir(root, { recursive: true, mode: 0o700 })): Promise<void> {
		await assertRoot(true);
		await create();
		await assertRoot();
	}
	async function assertFile(path: string, missing = false): Promise<Stats | undefined> {
		const absolute = child(path);
		await assertRoot();
		let stat: Stats;
		try { stat = await lstat(absolute); } catch (error) { if (missing && absent(error)) return; throw error; }
		if (!stat.isFile() || stat.isSymbolicLink() || !samePath(await realpath(absolute), absolute)) throw new StorageSecurityError();
		await assertRoot();
		return stat;
	}
	async function assertOpened(path: string, handle: FileHandle, expected?: Stats): Promise<Stats> {
		const opened = await handle.stat();
		const current = await assertFile(path);
		if (!opened.isFile() || !current || !sameFile(current, opened) || (expected && !sameFile(expected, opened))) throw new StorageSecurityError();
		return opened;
	}
	async function openedRead(path: string, maxBytes: number): Promise<Buffer> {
		const expected = await assertFile(path);
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await assertOpened(path, handle, expected);
			if (stat.size > maxBytes) throw new StorageSecurityError();
			const bytes = Buffer.alloc(maxBytes + 1);
			let size = 0;
			while (size < bytes.length) {
				const result = await handle.read(bytes, size, bytes.length - size, size);
				if (result.bytesRead === 0) break;
				size += result.bytesRead;
			}
			if (size > maxBytes) throw new StorageSecurityError();
			await assertOpened(path, handle, expected);
			return bytes.subarray(0, size);
		} finally { await handle.close(); }
	}
	return { root, child, assertRoot, ensureDirectory, assertFile, assertOpened, openedRead };
}
