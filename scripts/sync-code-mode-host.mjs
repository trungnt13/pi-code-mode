#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readFile,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = join(root, "vendor", "codex", "code-mode-host");
const workspaceRoot = join(vendorRoot, "codex-rs");
const provenancePath = join(vendorRoot, "provenance.json");
const patchPath = join(root, "vendor", "codex", "codex-code-mode-host.patch");
const MAX_COMMAND_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const CURRENT_PROVENANCE_SHA256 = "93a4dc9a857b70fed14dd2d7012d8dc3c40c5847379d0dbd758c6b85ef10e006";
const CURRENT_PATCH_SHA256 = "61f8a64ab08a302f7321ac4f1210c4ee1ff3abf4df3b064a6fb588b431a5b024";
const UPSTREAM_ROOTS = [
	"codex-rs/code-mode-host",
	"codex-rs/code-mode",
	"codex-rs/code-mode-protocol",
	"codex-rs/utils/cargo-bin",
];
const UPSTREAM_FILES = ["codex-rs/protocol/src/tool_name.rs"];
const LOCAL_CLASSIFICATIONS = new Set([
	"local_generated_lockfile",
	"local_standalone_workspace",
	"local_compatibility_scaffold",
]);
const UPSTREAM_CLASSIFICATIONS = new Set([
	"patched_upstream_tree",
	"exact_upstream_compatibility_source",
	"exact_upstream_test_helper",
]);

const options = parseArgs(process.argv.slice(2));
let checkout;
let output;
let initialHead;
let initialStatus;
let outputCreated = false;

try {
	checkout = await realpath(resolve(options.codex));
	const requestedOutput = resolve(options.output);
	const outputParent = await realpath(dirname(requestedOutput));
	output = join(outputParent, basename(requestedOutput));
	await requireAbsent(output, "Output");
	assertOutside(output, checkout, "Codex checkout");
	const packageRoot = await realpath(root);
	assertOutside(output, packageRoot, "package source tree");
	const configuredAgentRoot = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
	const agentRoot = await canonicalIfExists(configuredAgentRoot);
	assertOutside(output, agentRoot, "Pi agent install root");

	initialHead = (await git(checkout, ["rev-parse", "HEAD"])).toString("utf8").trim();
	initialStatus = await git(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (initialHead !== options.commit) {
		throw new Error(`Codex HEAD mismatch: expected ${options.commit}, received ${initialHead}`);
	}
	if (initialStatus.length !== 0) throw new Error("Codex checkout must have empty tracked and untracked status");
	const worktree = (await git(checkout, ["rev-parse", "--is-inside-work-tree"])).toString("utf8").trim();
	if (worktree !== "true") throw new Error("Codex path is not a Git worktree");

	const preimage = await validateCurrentPreimage();
	const provenance = preimage.provenance;
	const upstream = await discoverUpstream(checkout, options.commit);
	const localScaffolds = provenance.files.filter((entry) => LOCAL_CLASSIFICATIONS.has(entry.classification));
	if (localScaffolds.length === 0) throw new Error("Current provenance has no local standalone scaffold");

	await mkdir(output, { mode: 0o700 });
	outputCreated = true;
	const canonicalOutput = await realpath(output);
	if (canonicalOutput !== output) throw new Error(`Created output path is redirected: ${output}`);
	assertOutside(canonicalOutput, checkout, "Codex checkout");
	assertOutside(canonicalOutput, packageRoot, "package source tree");
	assertOutside(canonicalOutput, agentRoot, "Pi agent install root");
	await chmod(output, 0o700);
	const candidateRoot = join(output, "candidate");
	assertStrictDescendant(output, candidateRoot, "candidate root");
	await mkdir(candidateRoot, { mode: 0o700 });
	const currentPreimageRoot = join(output, "current-preimage");
	assertStrictDescendant(output, currentPreimageRoot, "current preimage root");
	await mkdir(currentPreimageRoot, { mode: 0o700 });
	for (const entry of provenance.files) {
		const captured = preimage.files.get(entry.path);
		if (!captured) throw new Error(`Captured current preimage omitted ${entry.path}`);
		await writeNewFile(
			destinationForGitPath(currentPreimageRoot, entry.path),
			captured.bytes,
			0o600,
			currentPreimageRoot,
		);
	}
	await writeNewFile(join(currentPreimageRoot, "provenance.json"), preimage.provenanceBytes, 0o600, currentPreimageRoot);
	await writeNewFile(
		join(currentPreimageRoot, "codex-code-mode-host.patch"),
		preimage.patchBytes,
		0o600,
		currentPreimageRoot,
	);

	const currentBySource = new Map(
		provenance.files.filter((entry) => entry.source_path !== null).map((entry) => [entry.source_path, entry]),
	);
	const upstreamReport = [];
	for (const entry of upstream) {
		const bytes = await git(checkout, ["cat-file", "blob", entry.blob_oid], undefined, MAX_FILE_BYTES);
		const destination = destinationForGitPath(candidateRoot, entry.path);
		await writeNewFile(destination, bytes, entry.mode === "100755" ? 0o700 : 0o600, candidateRoot);
		const content = identity(bytes);
		const current = currentBySource.get(entry.path);
		upstreamReport.push({
			source_path: entry.path,
			destination_path: `candidate/${entry.path}`,
			git_mode: entry.mode,
			blob_oid: entry.blob_oid,
			sha256: content.sha256,
			size_bytes: content.size_bytes,
			current_vendor_status: current ? (current.sha256 === content.sha256 ? "unchanged" : "changed") : "added",
			current_vendor_sha256: current?.sha256 ?? null,
		});
	}

	const localReport = [];
	for (const entry of localScaffolds) {
		const captured = preimage.files.get(entry.path);
		if (!captured) throw new Error(`Captured local scaffold omitted ${entry.path}`);
		const bytes = captured.bytes;
		await writeNewFile(destinationForGitPath(candidateRoot, entry.path), bytes, 0o600, candidateRoot);
		const content = identity(bytes);
		localReport.push({
			classification: entry.classification,
			source_path: entry.path,
			destination_path: `candidate/${entry.path}`,
			sha256: content.sha256,
			size_bytes: content.size_bytes,
		});
	}

	const newPaths = new Set(upstreamReport.map((entry) => entry.source_path));
	const deleted = provenance.files
		.filter((entry) => UPSTREAM_CLASSIFICATIONS.has(entry.classification) && !newPaths.has(entry.source_path))
		.map((entry) => entry.source_path)
		.sort();
	const added = upstreamReport.filter((entry) => entry.current_vendor_status === "added").map((entry) => entry.source_path);
	const changed = upstreamReport.filter((entry) => entry.current_vendor_status === "changed").map((entry) => entry.source_path);
	const unchanged = upstreamReport.filter((entry) => entry.current_vendor_status === "unchanged").map((entry) => entry.source_path);
	const report = {
		schema_version: 1,
		requested_commit: options.commit,
		current_copied_commit: provenance.source.copied_checkout_commit,
		checkout_path: checkout,
		initial_head: initialHead,
		initial_status: initialStatus.toString("utf8"),
		initial_status_sha256: sha256(initialStatus),
		upstream_roots: UPSTREAM_ROOTS,
		upstream_files: UPSTREAM_FILES,
		upstream: upstreamReport,
		local_scaffolds: localReport,
		current_preimage: {
			root: "current-preimage",
			files: provenance.files.map((entry) => ({
				path: entry.path,
				sha256: entry.sha256,
				size_bytes: entry.size_bytes,
			})),
		},
		comparison: { added, deleted, changed, unchanged },
	};
	await writeNewFile(
		join(output, "sync-report.json"),
		Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
		0o600,
		output,
	);

	const diff = await gitDiff(join(currentPreimageRoot, "codex-rs"), join(candidateRoot, "codex-rs"));
	await writeNewFile(join(output, "current-vendor-to-candidate.diff"), diff, 0o600, output);
	const summary = [
		`Codex host sync candidate: ${options.commit}`,
		`Upstream blobs: ${upstreamReport.length}`,
		`Local scaffold inputs: ${localReport.length}`,
		`Added: ${added.length}; deleted: ${deleted.length}; changed: ${changed.length}; unchanged: ${unchanged.length}`,
		"",
		"NEXT STEPS",
		"1. Review sync-report.json and current-vendor-to-candidate.diff.",
		"2. Reapply or update historical patch in candidate staging; never use fuzzy or three-way merge.",
		"3. Review and update standalone manifests, compatibility scaffold, Cargo.lock, provenance, and TypeScript constants.",
		"4. Build and run complete protocol/resource probes.",
		"5. Deliberately copy reviewed bytes into vendor; this command does not activate output.",
		"",
	].join("\n");
	await writeNewFile(join(output, "REVIEW.txt"), Buffer.from(summary), 0o600, output);

	await validateCurrentPreimage();
	await assertCheckoutUnchanged();
	console.log(`Created review-only host sync candidate at ${output}`);
} catch (error) {
	const failures = [error];
	if (outputCreated && output) {
		try {
			await rm(output, { recursive: true, force: true });
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
	}
	if (checkout && initialHead !== undefined && initialStatus !== undefined) {
		try {
			await assertCheckoutUnchanged();
		} catch (checkoutError) {
			failures.push(checkoutError);
		}
	}
	if (failures.length > 1) throw new AggregateError(failures, "Host sync and cleanup verification failed");
	throw error;
}

function parseArgs(args) {
	const result = {};
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index];
		const value = args[index + 1];
		if (!["--codex", "--commit", "--output"].includes(name) || value === undefined) {
			throw new Error("Usage: sync-code-mode-host --codex PATH --commit 40HEX --output NEW_PATH");
		}
		const key = name.slice(2);
		if (result[key] !== undefined) throw new Error(`Duplicate option ${name}`);
		result[key] = value;
	}
	if (typeof result.codex !== "string" || typeof result.output !== "string") {
		throw new Error("Usage: sync-code-mode-host --codex PATH --commit 40HEX --output NEW_PATH");
	}
	if (typeof result.commit !== "string" || !/^[a-f0-9]{40}$/.test(result.commit)) {
		throw new Error("--commit must be an exact lowercase 40-hex Git commit");
	}
	return result;
}

async function validateCurrentPreimage() {
	const encoded = await readRegular(provenancePath, MAX_FILE_BYTES);
	if (sha256(encoded) !== CURRENT_PROVENANCE_SHA256) throw new Error("Current host provenance SHA-256 mismatch");
	const provenance = JSON.parse(encoded.toString("utf8"));
	requireExactKeys(provenance, [
		"files",
		"preserved_trees",
		"prototype",
		"schema_version",
		"source",
		"structural_deviations",
	]);
	if (provenance.schema_version !== 1 || !Array.isArray(provenance.files) || provenance.files.length === 0) {
		throw new Error("Current host provenance schema is invalid");
	}
	requireExactKeys(provenance.source, [
		"copied_checkout_commit",
		"license",
		"patch_baseline_commit",
		"patch_path",
		"patch_sha256",
		"repository",
	]);
	requireExactKeys(provenance.prototype, [
		"cargo",
		"platform",
		"release_binary_sha256",
		"release_binary_size_bytes",
		"rustc",
		"standalone_lock_sha256",
	]);
	if (
		!/^[a-f0-9]{40}$/.test(provenance.source.copied_checkout_commit) ||
		!/^[a-f0-9]{40}$/.test(provenance.source.patch_baseline_commit) ||
		provenance.source.license !== "Apache-2.0" ||
		provenance.source.patch_path !== "vendor/codex/codex-code-mode-host.patch" ||
		!/^[a-f0-9]{64}$/.test(provenance.source.patch_sha256) ||
		provenance.source.repository !== "https://github.com/openai/codex" ||
		!Array.isArray(provenance.preserved_trees) ||
		JSON.stringify(provenance.preserved_trees) !==
			JSON.stringify(["codex-rs/code-mode-host", "codex-rs/code-mode", "codex-rs/code-mode-protocol"])
	) {
		throw new Error("Current host provenance source identity is invalid");
	}
	if (!Array.isArray(provenance.structural_deviations) || provenance.structural_deviations.length === 0) {
		throw new Error("Current host provenance structural deviations are invalid");
	}
	for (const deviation of provenance.structural_deviations) {
		requireExactKeys(deviation, ["path", "reason"]);
		if (typeof deviation.path !== "string" || typeof deviation.reason !== "string" || !deviation.reason) {
			throw new Error("Current host provenance structural deviation is invalid");
		}
	}
	const patch = await readRegular(patchPath, MAX_FILE_BYTES);
	if (
		provenance.source.patch_sha256 !== CURRENT_PATCH_SHA256 ||
		sha256(patch) !== CURRENT_PATCH_SHA256
	) {
		throw new Error("Current host patch SHA-256 mismatch");
	}
	const expectedPaths = new Set();
	const files = new Map();
	for (const entry of provenance.files) {
		requireExactKeys(entry, ["classification", "path", "sha256", "size_bytes", "source_path"]);
		validateGitPath(entry.path);
		if (entry.source_path !== null) validateGitPath(entry.source_path);
		if (
			(!LOCAL_CLASSIFICATIONS.has(entry.classification) && !UPSTREAM_CLASSIFICATIONS.has(entry.classification)) ||
			typeof entry.path !== "string" ||
			!entry.path.startsWith("codex-rs/") ||
			resolve(vendorRoot, entry.path) !== join(vendorRoot, entry.path) ||
			typeof entry.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(entry.sha256) ||
			!Number.isSafeInteger(entry.size_bytes) ||
			entry.size_bytes < 1 ||
			(entry.source_path !== null && typeof entry.source_path !== "string") ||
			(LOCAL_CLASSIFICATIONS.has(entry.classification) && entry.source_path !== null) ||
			(UPSTREAM_CLASSIFICATIONS.has(entry.classification) && entry.source_path !== entry.path)
		) {
			throw new Error(`Invalid current host provenance entry: ${String(entry.path)}`);
		}
		if (expectedPaths.has(entry.path)) throw new Error(`Duplicate current provenance path: ${entry.path}`);
		expectedPaths.add(entry.path);
		const bytes = await readRegular(join(vendorRoot, entry.path), MAX_FILE_BYTES);
		if (bytes.length !== entry.size_bytes || sha256(bytes) !== entry.sha256) {
			throw new Error(`Current vendored preimage mismatch: ${entry.path}`);
		}
		files.set(entry.path, { bytes, sha256: entry.sha256, size_bytes: entry.size_bytes });
	}
	const actualPaths = await listFiles(workspaceRoot, vendorRoot);
	if (
		actualPaths.size !== expectedPaths.size ||
		[...actualPaths].some((path) => !expectedPaths.has(path)) ||
		[...expectedPaths].some((path) => !actualPaths.has(path))
	) {
		throw new Error("Current vendored workspace file set differs from provenance");
	}
	return { provenance, provenanceBytes: encoded, patchBytes: patch, files };
}

async function discoverUpstream(cwd, commit) {
	const encoded = await git(cwd, ["ls-tree", "-r", "-z", commit, "--", ...UPSTREAM_ROOTS, ...UPSTREAM_FILES]);
	const entries = [];
	for (const item of encoded.toString("utf8").split("\0").filter(Boolean)) {
		const match = /^(\d{6}) ([^ ]+) ([0-9a-f]+)\t(.+)$/.exec(item);
		if (!match) throw new Error(`Malformed git ls-tree record: ${item}`);
		const [, mode, type, blob_oid, path] = match;
		if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
			throw new Error(`Unsupported upstream Git entry ${mode} ${type} ${path}`);
		}
		validateGitPath(path);
		if (!isAllowedUpstream(path)) throw new Error(`Upstream path escaped allowlist: ${path}`);
		entries.push({ mode, blob_oid, path });
	}
	if (entries.length === 0) throw new Error("Selected upstream source set is empty");
	return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function isAllowedUpstream(path) {
	return UPSTREAM_FILES.includes(path) || UPSTREAM_ROOTS.some((rootPath) => path.startsWith(`${rootPath}/`));
}

async function git(cwd, args, input, maxBuffer = MAX_COMMAND_BYTES) {
	try {
		const result = await execFileAsync("git", args, {
			cwd,
			encoding: "buffer",
			input,
			maxBuffer,
			windowsHide: true,
			shell: false,
		});
		return result.stdout;
	} catch (error) {
		const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : String(error.stderr ?? "");
		throw new Error(`git ${args.join(" ")} failed: ${stderr.slice(-64 * 1024).trim()}`);
	}
}

async function gitDiff(current, candidate) {
	try {
		const result = await execFileAsync("git", ["diff", "--no-index", "--binary", "--", current, candidate], {
			encoding: "buffer",
			maxBuffer: MAX_COMMAND_BYTES,
			windowsHide: true,
			shell: false,
		});
		return result.stdout;
	} catch (error) {
		if (error.code === 1 && Buffer.isBuffer(error.stdout)) return error.stdout;
		const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : String(error.stderr ?? "");
		throw new Error(`git diff --no-index failed: ${stderr.slice(-64 * 1024).trim()}`);
	}
}

async function assertCheckoutUnchanged() {
	const head = (await git(checkout, ["rev-parse", "HEAD"])).toString("utf8").trim();
	const status = await git(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (head !== initialHead || !status.equals(initialStatus)) throw new Error("Codex checkout changed during host sync");
}

async function readRegular(path, maximum) {
	const canonical = await realpath(path);
	if (canonical !== path) throw new Error(`Expected canonical regular file: ${path}`);
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size < 1 || info.size > maximum) throw new Error(`Invalid regular file: ${path}`);
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

async function writeNewFile(destination, bytes, mode, containmentRoot) {
	assertStrictDescendant(containmentRoot, destination, "write destination");
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
	const handle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
	try {
		await handle.writeFile(bytes);
	} finally {
		await handle.close();
	}
}

async function listFiles(directory, base) {
	const files = new Set();
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Current vendored workspace contains symlink: ${path}`);
		if (entry.isDirectory()) {
			for (const nested of await listFiles(path, base)) files.add(nested);
		} else if (entry.isFile()) {
			files.add(relative(base, path).replaceAll("\\", "/"));
		} else {
			throw new Error(`Current vendored workspace contains unsupported entry: ${path}`);
		}
	}
	return files;
}

function identity(bytes) {
	return { sha256: sha256(bytes), size_bytes: bytes.length };
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function requireExactKeys(value, expected) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Provenance object is invalid");
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
		throw new Error(`Provenance object fields are invalid: ${actual.join(",")}`);
	}
}

async function requireAbsent(path, label) {
	try {
		await lstat(path);
		throw new Error(`${label} already exists: ${path}`);
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
}

async function canonicalIfExists(path) {
	let cursor = resolve(path);
	const missing = [];
	for (;;) {
		try {
			const canonical = await realpath(cursor);
			if (missing.length === 0 && dirname(canonical) === canonical) {
				throw new Error(`Protected path cannot be filesystem root: ${path}`);
			}
			return resolve(canonical, ...missing.reverse());
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		try {
			const info = await lstat(cursor);
			if (info.isSymbolicLink()) throw new Error(`Protected path contains dangling symlink: ${cursor}`);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
		const parent = dirname(cursor);
		if (parent === cursor) throw new Error(`Could not canonicalize protected path: ${path}`);
		missing.push(basename(cursor));
		cursor = parent;
	}
}

function assertOutside(candidate, protectedRoot, label) {
	if (
		isSameOrWithin(path, protectedRoot, candidate) ||
		isSameOrWithin(path, candidate, protectedRoot)
	) {
		throw new Error(`Output must be outside ${label}: ${candidate}`);
	}
}

function isSameOrWithin(pathImplementation, rootPath, candidatePath) {
	const relation = pathImplementation.relative(rootPath, candidatePath);
	return (
		relation === "" ||
		(!relation.startsWith(`..${pathImplementation.sep}`) &&
			relation !== ".." &&
			!pathImplementation.isAbsolute(relation))
	);
}

function assertStrictDescendant(rootPath, candidatePath, label) {
	if (candidatePath === rootPath || !isSameOrWithin(path, rootPath, candidatePath)) {
		throw new Error(`${label} escapes output root: ${candidatePath}`);
	}
}

function validateGitPath(gitPath) {
	if (
		typeof gitPath !== "string" ||
		gitPath.startsWith("/") ||
		gitPath.includes("\\") ||
		/[\0-\x1f\x7f]/.test(gitPath) ||
		gitPath.split("/").some((component) => !component || component === "." || component === "..")
	) {
		throw new Error(`Git path is not normalized: ${String(gitPath)}`);
	}
}

function destinationForGitPath(rootPath, gitPath) {
	validateGitPath(gitPath);
	const destination = resolve(rootPath, ...gitPath.split("/"));
	assertStrictDescendant(rootPath, destination, "Git destination");
	return destination;
}
