# Release validation flow

For every finished feature, complete this sequence in order:

1. Finish implementation.
2. Validate locally.
3. Complete independent review and repair every accepted finding.
4. Commit and push the exact reviewed revision.
5. Run `pi update --all`.
6. Select a supported CodeModeOnly model in installed Pi, enable `/code-mode`,
   and require `/code-mode-status` to report `code-mode: enabled, active` and
   `provider: native CodeModeOnly` before sending a harmless dummy prompt.
7. Require the dummy prompt to finish successfully.

Do not run the installed smoke test against unpushed or stale package code. Stop
at the first failed step, repair it, and restart validation from the relevant
local check before committing a replacement revision.
