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

export interface PipelineManifestPipeline {
  id: string;
  stages: string[];
  depends_on?: string[];
  profile?: string;
  runtime_locks?: string[];
  work_items?: string[];
  decision_ids?: string[];
  research_ids?: string[];
  contract_ids?: string[];
  issue_numbers?: number[];
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
  planning_readiness?: unknown;
  open_decisions?: string[];
  source_type?: PipelineSourceType;
  repository?: string;
  source_issues?: PipelineIssueSource[];
  planning_base_sha?: string;
  freshness_sensitive_paths?: string[];
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
  status: PipelineStatus;
  created_at: string;
  updated_at: string;
  current_stage?: string;
  active_stages?: string[];
  source_type?: PipelineSourceType;
  repository?: string;
  source_issues?: PipelineIssueSource[];
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
