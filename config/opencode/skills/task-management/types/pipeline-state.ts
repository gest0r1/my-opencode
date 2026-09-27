export type PipelineStatus =
  | 'planned'
  | 'approved'
  | 'in_progress'
  | 'blocked'
  | 'ready'
  | 'release_ready'
  | 'failed'
  | 'completed';

export type StageStatus =
  'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed' | 'skipped';

export type RulesSource = 'project' | 'opencode_default';
export type PipelineSourceType = 'text' | 'file' | 'github_issues';
export type PlanningGateStatus = 'ready' | 'needs_revision' | 'blocked';

export type StageExecutor =
  | 'agent'
  | 'review'
  | 'local_gate'
  | 'git_verify'
  | 'git_publish'
  | 'github_ci'
  | 'github_dev';

export type GithubGateTrigger = 'push' | 'workflow_dispatch';
export type GithubDevMode = 'stateful';

export interface GithubGateContract {
  workflow: string;
  terminal_job: string;
  trigger: GithubGateTrigger;
  artifact?: string;
  environment?: string;
  mode?: GithubDevMode;
  source_ci_stage?: string;
  trusted_ref?: string;
  evidence_file?: string;
  bootstrap_required?: boolean;
  bootstrap_work_item_id?: string;
  timeout_seconds?: number;
}

export interface PipelineIssueSource {
  repository: string;
  number: number;
  url: string;
  title: string;
  updated_at?: string;
}

export interface PipelineIssueResult {
  repository: string;
  number: number;
  status: 'pending' | 'done' | 'partial' | 'not_done';
  pr_number?: number;
  merge_commit_sha?: string;
}

export interface PipelineGithubOutboxEvent {
  id: string;
  kind: 'pipeline_status' | 'pr_link';
  pipeline_id: string;
  issue_numbers: number[];
  from_status?: PipelineStatus;
  to_status?: PipelineStatus;
  pr_number?: number;
  created_at: string;
  delivered_issue_numbers?: number[];
}

export interface FrozenArtifact {
  path: string;
  sha256: string;
}

export interface PlanningGateEvidence {
  required: boolean;
  status: PlanningGateStatus;
  artifact: FrozenArtifact;
  review?: FrozenArtifact;
  cycles?: number;
  blocking_decision_ids?: string[];
}

export interface PlanningReadinessV2 {
  design_freeze: true;
  artifact_language?: string;
  required_gates: string[];
  gates: Record<string, PlanningGateEvidence>;
  required_artifacts: {
    decision_register: FrozenArtifact;
    technology_evidence: FrozenArtifact;
    contract_inventory: FrozenArtifact;
    test_strategy: FrozenArtifact;
    accepted_risks: FrozenArtifact;
    work_items: FrozenArtifact;
  };
}

export interface FrozenWorkItem {
  id: string;
  pipeline_id: string;
  path: string;
  sha256: string;
}

export interface ProjectPolicyRef {
  path: string;
  sha256: string;
}

export interface PipelineManifestPipeline {
  id: string;
  stages: string[];
  executors?: Record<string, StageExecutor>;
  github_gates?: Record<string, GithubGateContract>;
  depends_on?: string[];
  profile?: string;
  runtime_locks?: string[];
  work_items?: string[];
  decision_ids?: string[];
  research_ids?: string[];
  contract_ids?: string[];
  issue_numbers?: number[];
  exclusive_paths?: string[];
  migration_paths?: string[];
  fixture_paths?: string[];
  conflict_group?: string;
  ready_after_stage?: string;
  release_ready_after_stage?: string;
}

export interface GitSetup {
  base_sha: string;
  branch: string;
  source_sha?: string;
  checkout_paths?: string[];
  must_absent?: string[];
}

export interface PipelineManifest {
  schema_version: number;
  run_id: string;
  rules_file: string;
  rules_version: number;
  pipelines: PipelineManifestPipeline[];
  git_setup?: GitSetup;
  allowed_change_paths?: string[];
  gate_profiles?: Record<string, Record<string, string[]>>;
  planning_mode?: string;
  planning_readiness?: PlanningReadinessV2 | unknown;
  open_decisions?: string[];
  source_type?: PipelineSourceType;
  repository?: string;
  source_issues?: PipelineIssueSource[];
  source_snapshot_sha256?: string;
  planning_base_sha?: string;
  freshness_sensitive_paths?: string[];
  work_items?: FrozenWorkItem[];
  project_policy?: ProjectPolicyRef;
}

export interface StageEvidence {
  stage: string;
  status: 'completed' | 'failed' | 'blocked';
  agent?: string;
  message?: string;
  commands?: string[];
  artifacts?: string[];
  errors?: string[];
  recorded_at: string;
}

export interface StageRuntime {
  status: StageStatus;
  technical_fix_cycles?: number;
  started_at?: string;
  completed_at?: string;
  message?: string;
  evidence?: StageEvidence;
}

export interface PipelineRuntime {
  id: string;
  status: PipelineStatus;
  stages: Record<string, StageRuntime>;
  stage_order: string[];
  depends_on: string[];
  issue_numbers?: number[];
  ready_after_stage?: string;
  release_ready_after_stage?: string;
  current_stage?: string;
}

export interface PipelineState {
  schema_version: number;
  run_id: string;
  manifest_file?: string;
  manifest_sha256?: string;
  rules_file: string;
  rules_source?: RulesSource;
  rules_version: number;
  rules_sha256: string;
  project_policy_file?: string;
  project_policy_sha256?: string;
  status: PipelineStatus;
  created_at: string;
  updated_at: string;
  current_stage?: string;
  active_stages?: string[];
  source_type?: PipelineSourceType;
  repository?: string;
  source_issues?: PipelineIssueSource[];
  source_snapshot_sha256?: string;
  planning_base_sha?: string;
  run_base_sha?: string;
  issue_results?: PipelineIssueResult[];
  github_outbox?: PipelineGithubOutboxEvent[];
  pipelines: Record<string, PipelineRuntime>;
  history: Array<{
    pipeline_id: string;
    stage: string;
    status: StageStatus;
    timestamp: string;
    message?: string;
  }>;
}
