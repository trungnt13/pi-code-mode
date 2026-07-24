#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
Usage: run-agent-update.sh CODEX_CHECKOUT TARGET_COMMIT

Environment:
  CODEX_BIN                 Codex executable (default: codex)
  CODE_MODE_UPDATE_MODEL    Optional model passed to codex exec
  CODE_MODE_UPDATE_DRY_RUN  Set to 1 to validate inputs without starting agent
EOF
	exit 2
}

[[ $# -eq 2 ]] || usage

codex_checkout_input=$1
target_commit=$2
[[ $target_commit =~ ^[0-9a-f]{40}$ ]] || {
	echo "TARGET_COMMIT must be exact lowercase 40-hex Git commit" >&2
	exit 2
}

script_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
package_root=$(CDPATH= cd -- "$script_root/../../.." && pwd -P)
instruction="$script_root/UPDATE_WITH_AGENT.md"
sync_script="$package_root/scripts/sync-code-mode-host.mjs"

[[ -f $instruction ]] || {
	echo "Missing update instruction: $instruction" >&2
	exit 1
}
[[ -f $sync_script ]] || {
	echo "Missing maintainer sync command: $sync_script" >&2
	echo "Run this workflow from a pi-code-mode source checkout, not packed package." >&2
	exit 1
}
[[ -d $codex_checkout_input ]] || {
	echo "Codex checkout does not exist: $codex_checkout_input" >&2
	exit 2
}
codex_checkout=$(CDPATH= cd -- "$codex_checkout_input" && pwd -P)
if [[ $codex_checkout == *$'\n'* || $codex_checkout == *$'\r'* ]]; then
	echo "Codex checkout path cannot contain newline characters" >&2
	exit 2
fi
if [[ $codex_checkout == "$package_root" || $codex_checkout == "$package_root/"* ||
	$package_root == "$codex_checkout/"* ]]; then
	echo "Codex checkout and pi-code-mode package must be separate trees" >&2
	exit 1
fi

actual_head=$(git -C "$codex_checkout" rev-parse HEAD)
[[ $actual_head == "$target_commit" ]] || {
	echo "Codex HEAD mismatch: expected $target_commit, received $actual_head" >&2
	exit 1
}
if [[ -n $(git -C "$codex_checkout" status --porcelain=v1 --untracked-files=all) ]]; then
	echo "Codex checkout must have empty tracked and untracked status" >&2
	exit 1
fi
[[ $(git -C "$codex_checkout" rev-parse --is-inside-work-tree) == true ]] || {
	echo "Codex path is not a Git worktree: $codex_checkout" >&2
	exit 1
}

codex_bin=${CODEX_BIN:-codex}
command -v "$codex_bin" >/dev/null 2>&1 || {
	echo "Codex executable not found: $codex_bin" >&2
	exit 1
}
command -v node >/dev/null 2>&1 || {
	echo "Node.js is required for canonical path validation" >&2
	exit 1
}

temporary_root=${TMPDIR:-/tmp}
temporary_root=${temporary_root%/}
[[ -d $temporary_root ]] || {
	echo "Temporary root does not exist: $temporary_root" >&2
	exit 1
}
temporary_root=$(CDPATH= cd -- "$temporary_root" && pwd -P)

guard_paths() {
	node --input-type=module - "$package_root" "$codex_checkout" "$temporary_root" "${PI_CODING_AGENT_DIR:-}" "$1" <<'NODE'
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const [packageRoot, checkout, temporaryRoot, configuredAgentRoot, runRoot] = process.argv.slice(2);

for (const [label, value] of Object.entries({ packageRoot, checkout, temporaryRoot, runRoot })) {
	if (/[\r\n\0]/.test(value)) throw new Error(`${label} contains prompt control characters`);
}

const sameOrWithin = (root, candidate) => {
	const relation = relative(root, candidate);
	return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
};

const canonicalPotential = async (input) => {
	let cursor = resolve(input);
	const missing = [];
	for (;;) {
		try {
			const canonical = await realpath(cursor);
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
		if (parent === cursor) throw new Error(`Could not canonicalize protected path: ${input}`);
		missing.push(basename(cursor));
		cursor = parent;
	}
};

const agentRoot = await canonicalPotential(
	configuredAgentRoot || join(homedir(), ".pi", "agent"),
);
if (/[\r\n\0]/.test(agentRoot)) throw new Error("agentRoot contains prompt control characters");

for (const [label, protectedRoot] of [
	["Codex checkout", checkout],
	["package source tree", packageRoot],
	["Pi agent install root", agentRoot],
]) {
	if (sameOrWithin(protectedRoot, temporaryRoot)) {
		throw new Error(`Temporary root must be outside ${label}: ${temporaryRoot}`);
	}
	if (runRoot && (sameOrWithin(protectedRoot, runRoot) || sameOrWithin(runRoot, protectedRoot))) {
		throw new Error(`Agent run root must be outside ${label}: ${runRoot}`);
	}
}
NODE
}

guard_paths ""
run_root=$(mktemp -d "$temporary_root/pi-code-mode-host-agent.XXXXXX")
run_root=$(CDPATH= cd -- "$run_root" && pwd -P)
if ! guard_paths "$run_root"; then
	rmdir "$run_root"
	exit 1
fi
review_output="$run_root/review"
final_message="$run_root/final-message.md"

echo "Package root:   $package_root"
echo "Instruction:    $instruction"
echo "Codex checkout: $codex_checkout"
echo "Target commit:  $target_commit"
echo "Review output:  $review_output"
echo "Final message:  $final_message"

if [[ ${CODE_MODE_UPDATE_DRY_RUN:-0} == 1 ]]; then
	echo "Dry run complete; agent was not started."
	rmdir "$run_root"
	exit 0
fi

codex_args=(
	exec
	--cd "$package_root"
	--add-dir "$run_root"
	--sandbox workspace-write
	--ask-for-approval never
	--output-last-message "$final_message"
)
if [[ -n ${CODE_MODE_UPDATE_MODEL:-} ]]; then
	codex_args+=(--model "$CODE_MODE_UPDATE_MODEL")
fi
codex_args+=(-)

set +e
{
	cat "$instruction"
	cat <<EOF

## Runtime inputs supplied by runner

- Package root: $package_root
- Protected read-only Codex checkout: $codex_checkout
- Exact target Codex commit: $target_commit
- Required sync review output: $review_output

Use these exact inputs. Keep Codex checkout unchanged. Write temporary review
artifacts only under required sync review output. Work through investigation,
plan, relevant implementation, validation, and review until complete. If task
packet requires user approval for a high-impact choice, stop before that choice
and report exact decision needed; do not guess in non-interactive mode.
EOF
} | "$codex_bin" "${codex_args[@]}"
agent_status=$?
set -e

echo "Agent exit status: $agent_status"
echo "Final message: $final_message"
echo "Review artifacts: $review_output"
exit "$agent_status"
