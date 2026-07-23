import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installedMode = process.argv.includes("--installed");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

function fail(message) {
	throw new Error(message);
}

function command(program, args, options = {}) {
	const executable = process.platform === "win32" && program === "npm" ? "npm.cmd" : program;
	const result = spawnSync(executable, args, {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		...options,
	});
	if (result.error) fail(`${program} ${args.join(" ")} failed: ${result.error.message}`);
	if (result.status !== 0) {
		fail(
			`${program} ${args.join(" ")} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
	return result.stdout;
}

function assertManifest() {
	const extensions = packageJson.pi?.extensions;
	if (!Array.isArray(extensions) || extensions.length === 0) fail("package.json must declare pi.extensions");
	for (const extension of extensions) {
		if (typeof extension !== "string" || !/\.(?:ts|js)$/.test(extension)) {
			fail(`Unsupported Pi extension entry: ${String(extension)}`);
		}
		const relative = extension.replace(/^\.\//, "");
		command("git", ["ls-files", "--error-unmatch", "--", relative]);
		readFileSync(resolve(root, relative));
	}
	for (const field of ["main", "types", "exports"]) {
		if (field in packageJson) fail(`Source-first Pi package must not declare compiled ${field}`);
	}
	command("git", ["check-ignore", "-q", "--", "dist/index.js"]);
	const trackedDist = command("git", ["ls-files", "--", "dist"]).trim();
	if (trackedDist) fail(`dist must remain untracked:\n${trackedDist}`);
}

function assertPackedFiles() {
	const output = command("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
	let pack;
	try {
		pack = JSON.parse(output)[0];
	} catch (error) {
		fail(`Could not parse npm pack output: ${error instanceof Error ? error.message : String(error)}\n${output}`);
	}
	const packed = new Set(pack.files.map((file) => file.path));
	const required = command("git", [
		"ls-files",
		"--",
		"src",
		"vendor",
		"ARCHITECTURE.md",
		"LICENSE",
		"PROVENANCE.md",
		"README.md",
		"THIRD_PARTY_NOTICES.md",
	])
		.split("\n")
		.filter(Boolean);
	for (const path of [...required, "package.json"]) {
		if (!packed.has(path)) fail(`npm package payload is missing ${path}`);
	}
	for (const path of packed) {
		if (path === "dist" || path.startsWith("dist/")) fail(`npm package payload unexpectedly contains ${path}`);
	}
}

function assertRpcLoad() {
	const scratch = installedMode ? undefined : mkdtempSync(resolve(tmpdir(), "pi-code-mode-verify-"));
	const pi = process.env.PI_BIN ?? resolve(root, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
	const args = ["--mode", "rpc", "--no-session"];
	if (!installedMode) args.push("--no-extensions", "-e", resolve(root, "src/index.ts"));
	const env = { ...process.env, PI_OFFLINE: "1" };
	if (!installedMode) env.PI_CODING_AGENT_DIR = resolve(scratch, "agent");
	for (const name of [
		"PI_CODE_MODE_HOST_PATH",
		"PI_CODE_MODE_HOST_SHA256",
		"PI_CODE_MODE_HOST_SIZE",
		"PI_CODE_MODE_HOST_PLATFORM",
		"PI_CODE_MODE_HOST_ARCH",
	]) {
		delete env[name];
	}
	const input = [
		JSON.stringify({ id: "commands", type: "get_commands" }),
		JSON.stringify({ id: "status", type: "prompt", message: "/code-mode-status" }),
		JSON.stringify({ id: "toggle", type: "prompt", message: "/code-mode" }),
	].join("\n");
	const result = spawnSync(pi, args, {
		cwd: root,
		encoding: "utf8",
		env,
		input: `${input}\n`,
		maxBuffer: 16 * 1024 * 1024,
		timeout: 15_000,
	});
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	if (result.error) fail(`Pi RPC failed: ${result.error.message}`);
	if (result.status !== 0) fail(`Pi RPC exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	if (result.stderr.trim()) fail(`Pi RPC wrote stderr:\n${result.stderr}`);

	const events = result.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch (error) {
				fail(`Pi RPC emitted invalid JSONL: ${line}\n${error instanceof Error ? error.message : String(error)}`);
			}
		});
	const commandResponse = events.find((event) => event.id === "commands");
	if (!commandResponse?.success) fail("Pi RPC get_commands failed");
	const codeMode = commandResponse.data?.commands?.find(
		(command) => command.name === "code-mode" && command.source === "extension",
	);
	if (!codeMode) fail("Installed extension did not register /code-mode");
	const codeModeStatus = commandResponse.data?.commands?.find(
		(command) => command.name === "code-mode-status" && command.source === "extension",
	);
	if (!codeModeStatus) fail("Installed extension did not register /code-mode-status");
	const sourcePath = codeMode.sourceInfo?.path ?? codeMode.path;
	if (typeof sourcePath !== "string" || !sourcePath.replaceAll("\\", "/").endsWith("/src/index.ts")) {
		fail(`/code-mode has unexpected source path: ${String(sourcePath)}`);
	}
	if (!events.some((event) => event.id === "status" && event.success === true)) {
		fail("/code-mode-status did not succeed");
	}
	if (
		!events.some(
			(event) =>
				event.type === "extension_ui_request" &&
				event.method === "notify" &&
				typeof event.message === "string" &&
				event.message.includes("code-mode: off") &&
				event.message.includes("tools: unclaimed"),
		)
	) {
		fail("/code-mode-status did not report expected inactive state");
	}
	const enableError = events.find(
		(event) => event.type === "extension_error" && event.extensionPath === "command:code-mode",
	);
	if (enableError?.error !== "Code-mode host is not configured") {
		fail(`/code-mode toggle did not reach host validation: ${JSON.stringify(enableError)}`);
	}
	if (events.some((event) => String(event.error ?? "").includes("runtime load failed"))) {
		fail("Lazy TypeScript runtime import failed");
	}
}

assertManifest();
assertPackedFiles();
assertRpcLoad();
console.log(`Pi package verification passed (${installedMode ? "installed package" : "direct source"})`);
