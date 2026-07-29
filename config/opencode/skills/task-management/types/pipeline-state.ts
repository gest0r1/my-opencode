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

export interface PipelineManifestPipeline {
  id: string;
  stages: string[];
  depends_on?: string[];
  profile?: string;
}

export interface PipelineManifest {
  schema_version: number;
  run_id: string;
  rules_file: string;
  rules_version: number;
  pipelines: PipelineManifestPipeline[];
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
  current_stage?: string;
}

export interface PipelineState {
  schema_version: number;
  run_id: string;
  rules_file: string;
  rules_version: number;
  rules_sha256: string;
  status: PipelineStatus;
  created_at: string;
  updated_at: string;
  current_stage?: string;
  pipelines: Record<string, PipelineRuntime>;
  history: Array<{
    pipeline_id: string;
    stage: string;
    status: StageStatus;
    timestamp: string;
    message?: string;
  }>;
}
