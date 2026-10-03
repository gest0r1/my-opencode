# Shell Non-Interactive Strategy (Global)
Shell execution has no interactive terminal. Use explicit arguments, script modes, bounded timeouts and repository package-manager commands.

- Disable prompts/pagers/editors: `CI=true`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`, `GIT_PAGER=cat`, `PAGER=cat`, `PIP_NO_INPUT=1` where relevant.
- Prefer file read/edit tools; use shell only within role permissions. A non-interactive flag does not authorize force, deletion or privilege expansion.
- Keep existing lockfile/package-manager policy. Use `--help` when command flags are uncertain.
- Authentication/input requirements return a concrete blocker rather than hanging, piping secrets or bypassing host-key verification.
- Continue authorized work after tool results; stop for required owner decisions or terminal outcomes.
- `/pipeline-*` uses its command contract and deterministic CLI evidence. General-agent approval rules do not override an already approved RUN.

Managed by gest0r1/my-opencode for OpenCode V2.
