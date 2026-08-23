---
name: build
mode: primary
description: The default agent. Executes tools based on configured permissions.
model: opencode-go/mimo-v2.5
---

## Caveman Delegation Requirement

Whenever delegating to a subagent, include: `Load skill(name="caveman") as your first action.` The child session does not inherit skills from the parent.