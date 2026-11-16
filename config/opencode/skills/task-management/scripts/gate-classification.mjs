// Central gate safety classification. The frozen input_kind outranks a legacy name heuristic.
// An absent/unknown kind retains conservative behavior for old manifests.
const LEGACY_RUNTIME_NAME = /(runtime|deploy|release|smoke|install)/i;
const NON_TREE_KINDS = new Set(['candidate', 'candidate-contour', 'build-output', 'deployed-service']);
export function classifyGate(gate, config, commands = []) {
  const kind = config?.input_kind;
  const hasCandidateToken = commands.some(command => typeof command === 'string' && command.includes('{candidate_sha}'));
  const hasLifecycle = Boolean(config?.lifecycle);
  const hasArtifact = Boolean(config?.artifact_output);
  const explicitTree = kind === 'tree';
  const runtime = hasLifecycle || hasArtifact || hasCandidateToken || NON_TREE_KINDS.has(kind)
    || (!explicitTree && LEGACY_RUNTIME_NAME.test(gate))
    || (kind != null && !explicitTree && !NON_TREE_KINDS.has(kind));
  // Legacy PLAN probes historically allowed pre-publish release/install checks;
  // retain that compatibility, without enabling snapshot/result reuse for them.
  const legacyPlanProbe = kind == null && !hasCandidateToken && !hasLifecycle && !hasArtifact
    && !/(deploy|smoke)/i.test(gate);
  return {
    runtime,
    planProbeAllowed: !runtime || legacyPlanProbe,
    snapshotAllowed: !runtime,
    reuseAllowed: !runtime,
    advisoryAllowed: !runtime,
    legacyFallback: kind == null,
    reasons: [
      ...(hasLifecycle ? ['lifecycle'] : []),
      ...(hasArtifact ? ['artifact_output'] : []),
      ...(hasCandidateToken ? ['candidate_sha'] : []),
      ...(NON_TREE_KINDS.has(kind) ? [kind] : []),
      ...(kind == null && LEGACY_RUNTIME_NAME.test(gate) ? ['legacy_runtime_name'] : []),
      ...(kind != null && !explicitTree && !NON_TREE_KINDS.has(kind) ? ['unknown_input_kind'] : []),
    ],
  };
}
