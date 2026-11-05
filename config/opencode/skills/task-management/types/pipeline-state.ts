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
  | 'github_dev'
  | 'owner_acceptance';

export type GithubGateTrigger = 'push' | 'pull_request' | 'workflow_dispatch';
export type GithubDevMode = 'disposable' | 'stateful';

export interface GithubGateContract {
  workflow: string;
  terminal_job: string;
  required_jobs?: string[];
  trigger: GithubGateTrigger;
  pr_number?: number;
  artifact?: string;
  environment?: string;
  mode?: GithubDevMode;
  source_ci_stage?: string;
  trusted_ref?: string;
  concurrency_group?: string;
  target_id?: string;
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
    work_items: FrozenArtifact;
    technology_evidence?: FrozenArtifact;
    contract_inventory?: FrozenArtifact;
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

export type DeploymentTestMode = 'github' | 'opencode_host' | 'hybrid';
export type PostDeployTestMode = 'automated' | 'user' | 'automated_then_user';

export interface DeploymentValidationContract {
  stage: string;
  fresh_job?: string;
  upgrade_job?: string;
}

export interface DeploymentTestingStrategy {
  mode: DeploymentTestMode;
  owner_decision_id: string;
  github_validation_stage?: string;
  opencode_host_stage?: string;
  post_deploy_test?: PostDeployTestMode;
  owner_acceptance_stage?: string;
}


export interface PipelineManifestPipeline {
  id: string;
  deployable?: boolean;
  deployment_validation?: DeploymentValidationContract;
  testing_strategy?: DeploymentTestingStrategy;
  stages: string[];
  executors?: Record<string, StageExecutor>;
  github_gates?: Record<string, GithubGateContract>;
  future_github_gates?: Record<string, GithubGateContract>;
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
  /** First lane: holds the `test_rework` work items; every other agent lane depends on it. */
  test_preparation?: boolean;
}

export type TestReworkAction = 'update' | 'split' | 'rewrite' | 'add' | 'move_setup' | 'remove';

export interface TestReworkEntry {
  id: string;
  path: string;
  action: TestReworkAction;
  reason: string;
  work_item_id: string;
}

export interface GitSetup {
  base_sha: string;
  branch: string;
  source_sha?: string;
  checkout_paths?: string[];
  must_absent?: string[];
}

export interface PreservedBaseline {
  head_sha: string;
  changed_paths: string[];
  diff_sha256: string;
}

export type PipelineSupersedeReason =
  | 'MANIFEST_CONTRACT_CORRECTION'
  | 'BASELINE_SCOPE_MISMATCH'
  | 'PLANNING_EVIDENCE_CORRECTION'
  | 'OWNER_SCOPE_CHANGE'
  | 'ARCHITECTURE_REPLAN'
  | 'MAIN_DRIFT_REPLAN';

export interface PipelineLineage {
  change_class: 'supersede' | 'replan';
  supersedes: string;
  reason_code: PipelineSupersedeReason;
}

export interface RefreshRevalidation {
  classification: 'BOUNDED_IMPACT';
  inherited_from_run_id: string;
  new_base_sha: string;
  changed_paths: string[];
  affected_gates: string[];
  reasons: string[];
  rebuild_work_items: boolean;
  work_items_status?: 'needs_revision' | 'ready';
  impact_evidence: FrozenArtifact;
}

export interface PipelineManifest {
  schema_version: number;
  run_id: string;
  /** Generator outputs (exact paths or `dir/**`) that RUN may extend into without a reviewer. */
  generated_paths?: string[];
  rules_file: string;
  rules_version: number;
  pipelines: PipelineManifestPipeline[];
  git_setup?: GitSetup;
  allowed_change_paths?: string[];
  gate_profiles?: Record<string, Record<string, string[]>>;
  gate_testing?: Record<string, Record<string, {
    impact_groups?: Array<{ inputs: string[]; command_index: number; test_files?: string[] }>;
    live_postgres?: { image: string; command_indexes: number[] };
    timeout_seconds?: number;
    report_files?: string[];
  }>>;
  planning_mode?: string;
  planning_readiness?: PlanningReadinessV2 | unknown;
  open_decisions?: string[];
  source_type?: PipelineSourceType;
  repository?: string;
  source_issues?: PipelineIssueSource[];
  source_requirements_sha256?: string;
  /** Version taken from the milestone name once; candidates carry no tag, vX.Y.Z is set after acceptance. */
  release?: { version: string; milestone: { number: number; title: string } };
  /** Owner's dev contour key for /usr/local/sbin/opencode-deploy-target; svd1 by default. */
  deploy_target?: string;
  planning_base_sha?: string;
  planning_scope?: string[];
  /** Tests reworked by the test_preparation lane before source lanes start. */
  test_rework?: TestReworkEntry[];
  planning_inputs?: Record<string, string[]>;
  freshness_sensitive_paths?: string[];
  work_items?: FrozenWorkItem[];
  project_policy?: ProjectPolicyRef;
  deployment_target_check?: FrozenArtifact;
  preserved_baseline?: PreservedBaseline;
  lineage?: PipelineLineage;
  refresh_revalidation?: RefreshRevalidation;
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

export type RuntimeReplanStatus =
  | 'awaiting_owner_clarification'
  | 'awaiting_owner_approval'
  | 'approved'
  | 'superseded';

export interface TechnicalFixBudgetGrant {
  timestamp: string;
  source: 'owner_direct' | 'runtime_replan' | 'run_override';
  added_cycles: number;
  previous_limit: number;
  new_limit: number;
  runtime_replan_revision?: number;
}

export interface RuntimeReplanRecord {
  revision: number;
  status: RuntimeReplanStatus;
  proposed_at: string;
  evidence_path: string;
  evidence_sha256: string;
  owner_questions?: string[];
  summary?: string;
  approved_at?: string;
  granted_cycles?: number;
  superseded_at?: string;
}

export interface OwnerAmendmentWorkItem extends FrozenArtifact {
  id: string;
  pipeline_id: string;
}

export interface OwnerAmendmentRecord {
  revision: number;
  pipeline_id: string;
  source_stage: string;
  status: 'approved';
  summary: string;
  approved_at: string;
  evidence_path: string;
  evidence_sha256: string;
  acceptance_criteria_changed: boolean;
  requirements_changed: boolean;
  paths: string[];
  work_items: OwnerAmendmentWorkItem[];
}

export interface ArchitectureReviewRecord {
  path: string;
  sha256: string;
  result: 'no_change' | 'apply_within_requirements' | 'requirements_change';
  at: string;
}

/** Defect classes named by the negative result that charged one repair cycle. */
export interface DefectClassCycle {
  cycle: number;
  classes: string[];
  evidence_sha256: string;
}

export interface ClassReviewRecord {
  path: string;
  sha256: string;
  classes: string[];
  approach: 'rework_block' | 'remove_mechanism' | 'requirements_change';
  research_artifact: string;
  research_sha256?: string;
  summary_sha256?: string;
  /** technical_fix_cycles when recorded; the next charged cycle is the consolidated rework of these classes. */
  after_cycle: number;
  at: string;
}

export interface StageRuntime {
  // Repair execution borrows the initiating gate's existing budget; never a second loop.
  repair_origin_stage?: string;
  /** Cross-lane repair: pipeline whose gate stage `repair_origin_stage` holds the evidence and loop number (default: same pipeline). */
  repair_origin_pipeline?: string;
  /** Set when technical_fix_cycles reaches a multiple of ARCHITECTURE_REVIEW_AFTER; the next charged fix-cycle needs a recorded review. */
  architecture_review_due?: boolean;
  architecture_reviews?: ArchitectureReviewRecord[];
  defect_class_history?: DefectClassCycle[];
  /** Classes that recurred in consecutive negative results; the next cycle needs a recorded class review. */
  class_review_due?: string[];
  class_reviews?: ClassReviewRecord[];
  repair_evidence?: FrozenArtifact;
  repair_paths?: string[];
  status: StageStatus;
  technical_fix_cycles?: number;
  technical_fix_limit?: number;
  technical_fix_budget_grants?: TechnicalFixBudgetGrant[];
  runtime_replans?: RuntimeReplanRecord[];
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

export const RUNTIME_SCOPE_CLASSES = ['test', 'generated', 'technical', 'owner_amendment'] as const;
export type RuntimeScopeClass = (typeof RUNTIME_SCOPE_CLASSES)[number];

export interface RuntimeScopeExtension {
  timestamp: string;
  scope_class: RuntimeScopeClass;
  paths: string[];
  reason: string;
  evidence_path?: string;
  evidence_sha256?: string;
}

export interface ScopePreflight {
  timestamp: string;
  pipeline_id: string;
  stage: string;
  paths: string[];
}

export interface SecurityFixPreflight {
  timestamp: string;
  pipeline_id: string;
  stage: string;
  paths: string[];
  evidence_path: string;
  evidence_sha256: string;
}

/** Workflow audit data for a final design-freeze response. This records what the workflow received; it is not an authenticated transcript. */
export interface PipelineApprovalRecord {
  subject: 'final-manifest';
  run_id: string;
  decision: 'approved';
  shown_manifest_sha256: string;
  owner_response: string;
  recorded_at: string;
  message_id?: string;
  source_session?: string;
  /** Present when a technical revision carries the original approval to a new manifest hash. */
  current_manifest_sha256?: string;
  revision_evidence_path?: string;
  revision_evidence_sha256?: string;
  revision_reviewed_manifest_sha256?: string;
}

export interface PipelineState {
  approval_record?: PipelineApprovalRecord;
  deferred_decisions?: Array<{
    id: string; pipeline_id: string; source_stage: string; before_stage: string;
    status: 'pending' | 'approved' | 'rejected';
    evidence_path: string; evidence_sha256: string; summary: string;
  }>;
  reconciliations?: Array<{ path: string; sha256: string }>;
  execution_started_at?: string;
  implementation_started_at?: string;
  schema_version: number;
  run_id: string;
  manifest_file?: string;
  manifest_sha256?: string;
  rules_file: string;
  rules_origin_file?: string;
  rules_source?: RulesSource;
  rules_version: number;
  rules_sha256: string;
  rules_refresh_history?: Array<{
    timestamp: string;
    previous_file: string;
    previous_sha256: string;
    new_file: string;
    new_sha256: string;
  }>;
  runtime_scope_extensions?: RuntimeScopeExtension[];
  owner_amendments?: OwnerAmendmentRecord[];
  scope_preflight?: ScopePreflight;
  security_fix_preflight?: SecurityFixPreflight;
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
  source_requirements_sha256?: string;
  planning_base_sha?: string;
  run_base_sha?: string;
  refresh_impact_sha256?: string;
  superseded_by?: string;
  supersede_reason?: PipelineSupersedeReason;
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
