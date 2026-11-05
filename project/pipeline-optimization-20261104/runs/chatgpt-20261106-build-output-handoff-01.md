# Pipeline optimization — testing handoff, 2026-11-06

**Статус:** source-изменения этого запуска готовы к изолированному тестированию; исходный план в целом **частично заблокирован** до upstream merge/pins и независимой регрессии. Нет разрешения на merge/release/deploy.

**Канонический текущий отчёт:** [REPORT.md](../REPORT.md), source checkpoint `65b4e513e892d9d94ecf9af4adc1e50867d77e73`. **Инструкции тестировщику:** [TESTING_HANDOFF.md](../TESTING_HANDOFF.md). [DECISIONS.md](../DECISIONS.md), [synthetic timing sample](../artifacts/markdown-timing-synthetic.md).

## Репозитории

| Repo | base main | last feature commit before this note | remote |
|---|---|---|---|
| gest0r1/my-opencode | `c58f452047df3806ea6e946d1909b075344bc069` | `65b4e513e892d9d94ecf9af4adc1e50867d77e73` | https://github.com/gest0r1/my-opencode/tree/feature/pipeline-optimization-20261104 |
| gest0r1/openchamber-ru | `f9521f168c894cb17dc60ba4f929d4df0722e263` | `06afd56dffe3e0fc0c2863d0017ae243b037cc1b` | https://github.com/gest0r1/openchamber-ru/tree/feature/pipeline-optimization-20261104 |

Sevami repo, production, main, installs, Actions and releases untouched. Existing foreign worktrees/processes/locks not inspected; own container only used temporary native unit-test files under `/mnt/data/pipeline-native-test`, no background tasks.

## Изменения за запуск

- Новый `build-output-proof.mjs`: deterministic SHA-256 content proof; foreign run/pipeline/manifest/source/stage, stale output, path traversal rejected.
- Existing `gate-testing-policy.mjs`: `tree` producer with one generated `dist/` or `build/` artifact, explicit `build-output` consumer with frozen prior `local_gate` and `{artifact_path}` in all commands. PLAN probe does not materialize a build.
- Existing `gate-runner-cli.ts`: same runner executes producer in-place during RUN, emits normal gate evidence, consumer checks before/after artifact; neither command class is reusable, no secondary cache/approval store.
- New/updated regression source `build-output-proof.test.mjs`, `gate-testing-policy.test.mjs`, `gate-runner-cli.test.mjs`.
- Documentation `gate-testing.md`, `DECISIONS.md`, `REPORT.md`, `TESTING_HANDOFF.md`, synthetic Markdown sample; OpenChamber pointer fixed by docs-only commit.
- All changes committed remotely to feature branches using GitHub API. No uncommitted repository changes claimed; local runtime does not have a full repo checkout.

## Проверки

| Проверка | Input | Result | Duration / evidence |
|---|---|---|---|
| `node --test /mnt/data/pipeline-native-test/build-output-proof.test.mjs` | exact current remote blobs `1a4a0170d24b5c1a92bcfc13a9f997f1f6bf77a8`, `ce03a9540bf147c5726f4c1be8d7526941d1dcf6` | **PASS 2/2**, exit 0 | Node output: **82.186542 ms** duration; individual 12.81/7.15 ms |
| `git hash-object` on both local test files | fetched remote blobs via GitHub connector | **2/2 exact SHA match** | Native Git, no checkout dependency |
| Isolated V8 `validateGateTesting` source and artifact helper | 7 positive/negative producer order, path, placeholder, source/stage cases | **7/7 PASS**, not a native project test | No wall-clock proof |
| Remote GitHub branch/file reads, real commits | feature refs, exact file SHA | PASS | Existing feature branches; actual diff published |
| `node --test .../gate-runner-cli.test.mjs` and other exact-HEAD full suites | no full source/deps checkout | **NOT RUN** | test commands in TESTING_HANDOFF.md |
| OpenChamber `bun run check:changed`, type-check/build, upstream pinned merge and installed SDK | Bun/isolated checkout unavailable | **NOT RUN** | blocker |
| Actual live PostgreSQL, CI-local install rollback, comparative PLAN/RUN timings/tokens | requires isolated project runtime | **NOT RUN** | do not substitute synthetic evidence |

## Незакрытое и точка продолжения

1. **Тестировщик**: получить точные current feature SHAs, выполнить команды `TESTING_HANDOFF.md` в отдельном checkout, вернуть exit codes/logs, measured duration и ошибочные cases. После любого изменения исходника тестировать новый SHA заново.
2. **Upstream**: разрешить 18 textual conflicts + 6 delete/modify for OpenChamber v2.6.1 (source metadata `handoff-assets/upstream-conflicts-20261105/manifest.jsonl`); выполнить обязательный `bun run check:changed` before source commit. Согласовать OpenCode v2.2.5 pins/lockfiles и проверить UI/server/client, затем только готовность к независимой приёмке.
3. **Real runtime**: compaction/restart session, unknown child, synthetic wake, owner decision, live slots and published candidate service checks; scripts and required assertions are in the handoff.
4. No task-run/model capacity switches and no fabricated performance results. Report scope/source proof separately from production readiness.

**Передача:** опубликованные feature-ветки и тестовый чеклист готовы для тестового агента. Слияние/релиз запрещены до закрытия отмеченных блокеров.
