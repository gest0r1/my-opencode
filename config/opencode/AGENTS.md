# Shell Non-Interactive Strategy (Global)
Shell execution has no interactive terminal. Use explicit arguments, script modes, bounded timeouts and repository package-manager commands.

- Disable prompts/pagers/editors: `CI=true`, `GIT_TERMINAL_PROMPT=0`, `GIT_EDITOR=true`, `GIT_PAGER=cat`, `PAGER=cat`, `PIP_NO_INPUT=1` where relevant.
- Prefer file read/edit tools; use shell only within role permissions. A non-interactive flag does not authorize force, deletion or privilege expansion.
- Keep existing lockfile/package-manager policy. Use `--help` when command flags are uncertain.
- Authentication/input requirements return a concrete blocker rather than hanging, piping secrets or bypassing host-key verification.
- Continue authorized work after tool results; stop for required owner decisions or terminal outcomes.
- `/pipeline-*` uses its command contract and deterministic CLI evidence. General-agent approval rules do not override an already approved RUN.

Managed by gest0r1/my-opencode for OpenCode V2.


For explicitly requested software installation, use `sudo -n /usr/local/sbin/opencode-install-packages update` and `sudo -n /usr/local/sbin/opencode-install-packages install <package>...`. The root bootstrap grants this package-only command without a password. Obtain the tool's requested confirmation; never bypass sudo policy or use arbitrary root shell commands.

## Local source reading (all agents)
- Start with supplied context packets and changed-file lists. If a local path is known, read it directly; use `glob` only to discover unknown paths, or `grep` to locate a symbol before reading a relevant range. This is task-based selection, not a mandatory `glob -> grep -> read` sequence.
- Prefer `read` for ordinary local analysis. An available, permitted local raw-file tool (including `fetch file://` if the actual tool supports it) is appropriate when full raw text or significant whitespace/newlines are needed, or `read` is unavailable or changes the representation. Verify the tool preserves the needed content; raw text alone does not prove byte identity. Byte-exact copies require an authorized deterministic copy/hash check; report that capability gap if unavailable.
- Never bypass an explicit file/path permission denial using another transport. Tool unavailability is distinct from a permission denial. Do not assume HTTP-only `webfetch` supports `file://`; external search is not a local-file fallback. Keep web/research tools for external URLs and version-specific facts.
- Avoid reopening unchanged files or rereading overlapping ranges unless new edits, missing context, or verification require it. Use targeted reads rather than entire large files; expand only as necessary for correctness.
- Do not impose a fixed tool-call budget or omit required checks. Prefer fewer relevant reads without compromising correctness or evidence.
