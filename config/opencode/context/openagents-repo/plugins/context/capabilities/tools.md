# OpenCode V2 native tools

Register custom tools through `Plugin.define` and `plugin.tool.transform(editor => editor.add(...))` from `@opencode/plugin`. Definitions use `name`, JSON Schema `input`, `description`, and an async `execute` returning `{ content }`. `github-handoff.ts` registers the four authenticated `github_handoff_*` tools. The V1 custom-tool helper is no longer an installed dependency.
