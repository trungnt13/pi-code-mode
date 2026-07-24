import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { HostIdentity } from "./runtime/host-client.js";

export const HOST_MANIFEST_SCHEMA_VERSION = 1;
export const HOST_PROBE_VERSION = 1;
export const HOST_PACKAGE_NAME = "pi-code-mode";
export const HOST_PACKAGE_VERSION = "0.1.0";
export const HOST_SOURCE_COMMIT = "808d3c2702ce8eae007c457aa930e7c3b68dd5f6";
export const HOST_PATCH_SHA256 = "61f8a64ab08a302f7321ac4f1210c4ee1ff3abf4df3b064a6fb588b431a5b024";
export const HOST_LOCK_SHA256 = "ad36b876206bf917d3519d621738e5c225ab90b6417d3dac28d88c05c8447a98";
export const HOST_PROVENANCE_SHA256 = "93a4dc9a857b70fed14dd2d7012d8dc3c40c5847379d0dbd758c6b85ef10e006";
export const HOST_PROTOCOL_VERSION = 1;
export const HOST_RESOURCE_CAPABILITY = "resource_limits_v1";

const MANIFEST_BYTES = 64 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;
const MANIFEST_KEYS = [
	"architecture",
	"capabilities",
	"executableRelativePath",
	"lockSha256",
	"packageName",
	"packageVersion",
	"patchSha256",
	"platform",
	"probeVersion",
	"protocolVersion",
	"provenanceSha256",
	"schemaVersion",
	"sha256",
	"sizeBytes",
	"sourceCommit",
] as const;

export interface InstalledHostManifest {
	schemaVersion: number;
	probeVersion: number;
	packageName: string;
	packageVersion: string;
	sourceCommit: string;
	patchSha256: string;
	lockSha256: string;
	provenanceSha256: string;
	platform: NodeJS.Platform;
	architecture: NodeJS.Architecture;
	executableRelativePath: string;
	sha256: string;
	sizeBytes: number;
	protocolVersion: number;
	capabilities: string[];
}

export function hostInstallRoot(): string {
	return resolve(getAgentDir(), "bin", HOST_PACKAGE_NAME);
}

export async function ensureCanonicalHostInstallRoot(): Promise<string> {
	const agentRoot = await realpath(resolve(getAgentDir()));
	const binRoot = await ensureCanonicalDirectory(join(agentRoot, "bin"));
	return await ensureCanonicalDirectory(join(binRoot, HOST_PACKAGE_NAME));
}

export async function resolveCanonicalHostInstallRoot(): Promise<string | undefined> {
	let agentRoot: string;
	try {
		agentRoot = await realpath(resolve(getAgentDir()));
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
	const binRoot = await resolveCanonicalDirectory(join(agentRoot, "bin"));
	if (!binRoot) return undefined;
	return await resolveCanonicalDirectory(join(binRoot, HOST_PACKAGE_NAME));
}

export function hostExecutableName(): string {
	return process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
}

export function createInstalledHostManifest(identity: HostIdentity): InstalledHostManifest {
	return {
		schemaVersion: HOST_MANIFEST_SCHEMA_VERSION,
		probeVersion: HOST_PROBE_VERSION,
		packageName: HOST_PACKAGE_NAME,
		packageVersion: HOST_PACKAGE_VERSION,
		sourceCommit: HOST_SOURCE_COMMIT,
		patchSha256: HOST_PATCH_SHA256,
		lockSha256: HOST_LOCK_SHA256,
		provenanceSha256: HOST_PROVENANCE_SHA256,
		platform: identity.platform,
		architecture: identity.architecture,
		executableRelativePath: `hosts/${identity.sha256}/${hostExecutableName()}`,
		sha256: identity.sha256,
		sizeBytes: identity.sizeBytes,
		protocolVersion: HOST_PROTOCOL_VERSION,
		capabilities: [HOST_RESOURCE_CAPABILITY],
	};
}

export async function resolveInstalledHostIdentity(): Promise<HostIdentity | undefined> {
	const root = await resolveCanonicalHostInstallRoot();
	if (!root) return undefined;
	const manifestPath = join(root, "current.json");
	let encoded: Buffer;
	try {
		encoded = await readRegularFileNoFollow(manifestPath, MANIFEST_BYTES, "installed host manifest");
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(encoded.toString("utf8"));
	} catch (error) {
		throw new Error(`Installed code-mode host manifest is invalid JSON: ${errorMessage(error)}`);
	}
	const manifest = parseManifest(value);
	const expectedRelativePath = `hosts/${manifest.sha256}/${hostExecutableName()}`;
	if (manifest.executableRelativePath !== expectedRelativePath) {
		throw new Error("Installed code-mode host manifest executable path does not match content identity");
	}
	const executable = join(root, "hosts", manifest.sha256, hostExecutableName());
	if (resolve(executable) !== executable || !isWithin(root, executable)) {
		throw new Error("Installed code-mode host path escapes install root");
	}
	const canonicalExecutable = await realpath(executable);
	if (canonicalExecutable !== executable) {
		throw new Error("Installed code-mode host path must be canonical and contain no symlink");
	}
	const handle = await open(executable, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Installed code-mode host is not a regular file");
		if (info.size !== manifest.sizeBytes) {
			throw new Error(`Installed code-mode host size mismatch: expected ${manifest.sizeBytes}, received ${info.size}`);
		}
		if (process.platform !== "win32" && (info.mode & 0o111) === 0) {
			throw new Error("Installed code-mode host is not executable");
		}
		const actualHash = await hashHandle(handle, manifest.sizeBytes);
		if (actualHash !== manifest.sha256) {
			throw new Error(
				`Installed code-mode host checksum mismatch: expected ${manifest.sha256}, received ${actualHash}`,
			);
		}
	} finally {
		await handle.close();
	}
	return {
		executablePath: executable,
		sha256: manifest.sha256,
		sizeBytes: manifest.sizeBytes,
		platform: manifest.platform,
		architecture: manifest.architecture,
	};
}

async function ensureCanonicalDirectory(path: string): Promise<string> {
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if (!hasCode(error, "EEXIST")) throw error;
	}
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error(`Code-mode host install path is not a real directory: ${path}`);
	}
	const canonical = await realpath(path);
	if (canonical !== path) throw new Error(`Code-mode host install path is redirected: ${path}`);
	return canonical;
}

async function resolveCanonicalDirectory(path: string): Promise<string | undefined> {
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error(`Code-mode host install path is not a real directory: ${path}`);
	}
	const canonical = await realpath(path);
	if (canonical !== path) throw new Error(`Code-mode host install path is redirected: ${path}`);
	return canonical;
}

function parseManifest(value: unknown): InstalledHostManifest {
	const record = requireRecord(value, "installed host manifest");
	const keys = Object.keys(record).sort();
	const expected = [...MANIFEST_KEYS].sort();
	if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
		throw new Error("Installed code-mode host manifest has missing or unknown fields");
	}
	requireExactInteger(record.schemaVersion, HOST_MANIFEST_SCHEMA_VERSION, "schema version");
	requireExactInteger(record.probeVersion, HOST_PROBE_VERSION, "probe version");
	requireExactString(record.packageName, HOST_PACKAGE_NAME, "package name");
	requireExactString(record.packageVersion, HOST_PACKAGE_VERSION, "package version");
	requireExactString(record.sourceCommit, HOST_SOURCE_COMMIT, "source commit");
	requireExactString(record.patchSha256, HOST_PATCH_SHA256, "patch SHA-256");
	requireExactString(record.lockSha256, HOST_LOCK_SHA256, "lock SHA-256");
	requireExactString(record.provenanceSha256, HOST_PROVENANCE_SHA256, "provenance SHA-256");
	requireExactString(record.platform, process.platform, "platform");
	requireExactString(record.architecture, process.arch, "architecture");
	requireExactInteger(record.protocolVersion, HOST_PROTOCOL_VERSION, "protocol version");
	if (
		!Array.isArray(record.capabilities) ||
		record.capabilities.length !== 1 ||
		record.capabilities[0] !== HOST_RESOURCE_CAPABILITY
	) {
		throw new Error("Installed code-mode host manifest capability is invalid");
	}
	if (typeof record.sha256 !== "string" || !/^[a-f\d]{64}$/.test(record.sha256)) {
		throw new Error("Installed code-mode host manifest SHA-256 is invalid");
	}
	if (!Number.isSafeInteger(record.sizeBytes) || (record.sizeBytes as number) < 1) {
		throw new Error("Installed code-mode host manifest size is invalid");
	}
	if (typeof record.executableRelativePath !== "string") {
		throw new Error("Installed code-mode host manifest executable path is invalid");
	}
	return record as unknown as InstalledHostManifest;
}

async function readRegularFileNoFollow(path: string, maximumBytes: number, label: string): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`${label} is not a regular file`);
		if (info.size < 1 || info.size > maximumBytes) throw new Error(`${label} has invalid size`);
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

async function hashHandle(handle: Awaited<ReturnType<typeof open>>, expectedBytes: number): Promise<string> {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
	let total = 0;
	for (;;) {
		const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
		if (bytesRead === 0) break;
		total += bytesRead;
		if (total > expectedBytes) throw new Error("Installed code-mode host grew while hashing");
		hash.update(buffer.subarray(0, bytesRead));
	}
	if (total !== expectedBytes) throw new Error("Installed code-mode host changed while hashing");
	return hash.digest("hex");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function requireExactString(value: unknown, expected: string, label: string): void {
	if (value !== expected) throw new Error(`Installed code-mode host manifest ${label} is incompatible`);
}

function requireExactInteger(value: unknown, expected: number, label: string): void {
	if (value !== expected) throw new Error(`Installed code-mode host manifest ${label} is incompatible`);
}

function isWithin(root: string, path: string): boolean {
	return path.startsWith(`${root}/`) || (process.platform === "win32" && path.startsWith(`${root}\\`));
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
