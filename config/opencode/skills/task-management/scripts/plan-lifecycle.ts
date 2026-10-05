// Approval is editable until the first source-changing agent stage starts.
export function implementationStarted(state: any, manifest: any): boolean {
  if (state?.implementation_started_at) return true;
  return (manifest?.pipelines ?? []).some((spec: any) =>
    (spec.stages ?? []).some((stage: string) => spec.executors?.[stage] === 'agent' && (
      state?.pipelines?.[spec.id]?.stages?.[stage]?.started_at ||
      (state?.history ?? []).some((event: any) => event.pipeline_id === spec.id && event.stage === stage && event.status === 'in_progress')
    )));
}

export function hasActiveStages(state: any): boolean {
  return (state?.active_stages ?? []).length > 0 ||
    Object.values(state?.pipelines ?? {}).some((pipeline: any) =>
      Object.values(pipeline.stages ?? {}).some((stage: any) => stage.status === 'in_progress'));
}
