import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));

// Native Node imports are not enough: pi's real jiti loader aliases pi-ai's root
// to a file. /api/* subpaths used to resolve below that file and fail to load.
test("real pi 1.5.0 loader registers native CLI adapters from models.json with no environment keys", { timeout: 60_000 }, async () => {
	const temp = await mkdtemp(join(tmpdir(), "pi-chameleon-load-test-"));
	try {
		const config = join(temp, "config");
		const workspace = join(temp, "workspace");
		await mkdir(config);
		await mkdir(workspace);
		await writeFile(join(config, "settings.json"), JSON.stringify({
			retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
			cacheWarming: "off",
		}));
		const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
			!name.startsWith("ANTHROPIC_") && !name.startsWith("CLAUDE_") &&
			!name.startsWith("CHAMELEON_") && !name.startsWith("PI_") &&
			!name.startsWith("OPENAI_"),
		));
		await writeFile(join(config, "models.json"), JSON.stringify({
			providers: {
				"chameleon-claude": { baseUrl: "https://relay.example.com", apiKey: "offline-fixture-key",
					models: [{ id: "relay-custom-claude", api: "anthropic-messages", name: "Explicit Claude fixture", reasoning: false }] },
				"chameleon-codex": { baseUrl: "https://relay.example.com/v1", apiKey: "offline-fixture-key",
					models: [{ id: "relay-custom-codex", api: "openai-responses", name: "Explicit Codex fixture", reasoning: false }] },
			},
		}));
		Object.assign(env, {
			PI_CODING_AGENT_DIR: config,
			PI_OFFLINE: "",
			NO_COLOR: "1",
		});
		const { stdout, stderr } = await exec(process.execPath, [
			join(hostDist, "cli.js"),
			"--no-extensions", "--no-mcp", "--no-skills", "--no-session",
			"-e", project, "--list-models",
		], { cwd: workspace, env, timeout: 45_000 });
		assert.match(stdout, /chameleon-claude\s+relay-custom-claude/);
		assert.match(stdout, /chameleon-codex\s+relay-custom-codex/);
		assert.doesNotMatch(stdout, /chameleon-claude\s+claude-(?:opus|sonnet)-/);
		assert.doesNotMatch(stdout, /chameleon-codex\s+gpt-5\./);
		assert.doesNotMatch(stderr, /Failed to load|Cannot find module|Error:/);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
