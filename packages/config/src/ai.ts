/** AI/MLOps registry configuration group (MLflow Model Registry). */
import { z } from 'zod';
import { parseEnv } from './validate.js';

export interface AiConfig {
  mlflowTrackingUri: string;
  artifactsBucket: string;
}

export function loadAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const c = parseEnv(
    z.object({
      MLFLOW_TRACKING_URI: z.string().min(1),
      MLFLOW_ARTIFACTS_BUCKET: z.string().min(1).default('mlflow-artifacts'),
    }),
    env,
    'ai',
  );
  return { mlflowTrackingUri: c.MLFLOW_TRACKING_URI, artifactsBucket: c.MLFLOW_ARTIFACTS_BUCKET };
}
