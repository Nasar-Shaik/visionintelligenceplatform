import { useQuery } from '@tanstack/react-query';
import { http } from '@/lib/api/http';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The AI runtime's engineering view (P-8 Phase 3).
 *
 * ⚠️ **Two sources, kept apart.** `pipeline` is what the media service measured about the frames it
 * sent; `runtime` is what the runtime says about itself. They are never merged, because their
 * disagreement is the diagnosis: media delivering 600 frames while the runtime reports 200 processed
 * is a real finding, and an averaged number would hide it.
 *
 * ⚠️ Every field is optional. This is a **measured** payload — a runtime that has not been asked to
 * do anything reports nothing rather than zeros, and the page must render "not measured" rather than
 * a confident 0 ms.
 */
export interface AiRuntimePipeline {
  offered: number;
  delivered: number;
  droppedQueueFull: number;
  droppedNoImage: number;
  failed: number;
  inflight: number;
  queueDepth: number;
  activeCameras: number;
  deliverMsAvg: number;
  frameAgeMsAvg: number;
  detections: number;
  detectionsByLabel: Record<string, number>;
  framesWithDetections: number;
  inferenceMsAvg: number;
  frameLatencyMsAvg: number;
  lastDetectionAt?: string;
  modelId?: string;
  executionProvider?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface AiRuntimeModel {
  id: string;
  name: string;
  version: string;
  family: string;
  engine: string;
  format: string;
  status: string;
  default: boolean;
  inputSize: [number, number];
  labelCount: number;
  sizeBytes: number;
  checksum: string;
  license: string;
  trainedOn: string;
  artifactPresent: boolean;
}

export interface AiRuntimeCapability {
  capabilityId: string;
  state: 'READY' | 'LOADING' | 'FAILED' | 'DISABLED' | 'UNAVAILABLE';
  executionProvider?: string;
  model?: { id?: string; name: string; version: string; family: string; accelerator: string };
  adapter?: {
    modelId?: string;
    outputFormat?: string;
    preprocessingVersion?: string;
    executionProvider?: string;
    availableProviders?: string[];
    inputSize?: [number, number];
    inputLayout?: string;
    intraOpThreads?: number;
    warmupMs?: number;
    lastInferenceMs?: number;
  };
  metrics?: {
    fps?: number;
    framesProcessed?: number;
    droppedFrames?: number;
    avgLatencyMs?: number;
    latencyP50Ms?: number;
    latencyP95Ms?: number;
    avgFrameLatencyMs?: number;
    queueDepth?: number;
    detectionsTotal?: number;
    detectionsByLabel?: Record<string, number>;
    avgConfidence?: number;
    memoryMb?: number;
    uptimeSeconds?: number;
  };
}

export interface AiRuntimeView {
  configured: boolean;
  detail?: string;
  capabilityId?: string;
  observedAt: string;
  pipeline: AiRuntimePipeline | null;
  runtime: {
    reachable: boolean;
    latencyMs?: number;
    detail?: string;
    runtimeVersion?: string;
    uptimeSeconds?: number;
    executionProvider?: string;
    health?: 'ok' | 'degraded' | 'failed' | 'unknown';
    capabilities?: AiRuntimeCapability[];
    registeredModels?: AiRuntimeModel[] | null;
    cameras?: number;
    sessionsActive?: number | null;
    resources?: {
      memoryMb?: number | null;
      cpuPercent?: number | null;
      cpuCores?: number | null;
      gpuPercent?: number | null;
    };
  } | null;
}

/**
 * ⚠️ Five seconds, not fifteen. This is an engineering page watched during a deploy or a load test,
 * where the question is "did that change anything?" — and unlike System Health there is no
 * server-side cache collapsing concurrent viewers, so the interval is the budget. It still stops
 * polling when the tab is not visible, because a forgotten wall display must not become load on the
 * one service that writes evidence.
 */
export function useAiRuntime() {
  return useQuery({
    queryKey: queryKeys.health.aiRuntime(),
    queryFn: () => http.get<AiRuntimeView>('/system/ai-runtime'),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    retry: false,
    staleTime: 0,
  });
}
