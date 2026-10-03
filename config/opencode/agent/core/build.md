---
name: build
mode: primary
description: The default agent. Executes tools based on configured permissions.
model: opencode-go/mimo-v2.6-flash
permission:
  doom_loop:
    "*": ask
  external_directory:
    "$HOME/.local/share/opencode/tool-output/*": allow
    "/tmp/opencode/*": allow
    "$HOME/.agents/skills/find-skills/*": allow
    "$HOME/.agents/skills/caveman/*": allow
    "$HOME/.config/opencode/skills/task-management/*": allow
    "*": ask
  plan_exit:
    "*": deny
  read:
    "*.env": ask
    "*.env.*": ask
    "*.env.example": allow
  subagent:
    "*": deny
  context7_*:
    "*": deny
  exa_*:
    "*": deny
  gh_grep_*:
    "*": deny
  kagi_*:
    "*": deny
  webfetch:
    "*": deny
---

## Caveman Delegation Requirement

Whenever delegating to a subagent, include: `Load skill(name="caveman") as your first action.` The child session does not inherit skills from the parent.
