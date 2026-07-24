# Release validation flow

For every finished feature, complete this sequence in order:

1. Finish implementation.
2. Validate locally.
3. Complete independent review and repair every accepted finding.
4. Commit and push the exact reviewed revision.
5. Run `pi update --all`.
6. Select a supported CodeModeOnly model in installed Pi, enable `/code-mode`,
   and require `/code-mode-status` to report `code-mode: enabled, active` and
   `provider: native CodeModeOnly` before sending a harmless prompt that invokes `exec`, whose
   JavaScript invokes one harmless nested Pi tool.
7. Require ordered evidence of provider custom `exec`, nested Pi tool output, outer tool result,
   provider replay, final assistant text, and a running host; require prompt settlement within
   120 seconds from prompt acceptance through `agent_settled`. On expiry, send abort and require
   settlement within 10 additional seconds; otherwise fail release validation.

Do not run the installed smoke test against unpushed or stale package code. Stop
at the first failed step, repair it, and restart validation from the relevant
local check before committing a replacement revision.
