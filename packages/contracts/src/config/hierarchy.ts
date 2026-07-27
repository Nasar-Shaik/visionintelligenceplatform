/**
 * Configuration hierarchy (docs/architecture/06-MULTI-TENANT-SAAS.md §6; ADR-0014).
 * Config is a sparse-override inheritance chain: a child inherits the parent's effective config;
 * only overridden keys change; most-specific level wins; a parent may LOCK a key. Every effective
 * value records its source level (provenance) and is versioned/auditable/rollback-able.
 */
import { z } from 'zod';

/** The ordered inheritance chain (parent → child). Index = precedence (higher index wins). */
export const CONFIG_LEVELS = [
  'global',
  'platform',
  'tenant',
  'organization',
  'region',
  'country',
  'branch',
  'site',
  'building',
  'floor',
  'zone',
  'camera',
  'capability',
  'model',
  'rule',
  'workflow',
] as const;

export const ConfigLevel = z.enum(CONFIG_LEVELS);
export type ConfigLevel = z.infer<typeof ConfigLevel>;

/** Precedence rank; higher = more specific = wins on conflict. */
export function configLevelRank(level: ConfigLevel): number {
  return CONFIG_LEVELS.indexOf(level);
}

/** A single config override set at one level of the chain. */
export const ConfigNode = z.object({
  level: ConfigLevel,
  /** Id of the entity at this level (e.g. a cameraId when level="camera"). */
  nodeId: z.string(),
  /** Sparse key/values — only the keys this level overrides. */
  values: z.record(z.string(), z.unknown()).default({}),
  /** Keys locked here that descendants may NOT override (e.g. compliance-mandated retention floor). */
  lockedKeys: z.array(z.string()).default([]),
  version: z.number().int().nonnegative().default(0),
});
export type ConfigNode = z.infer<typeof ConfigNode>;

/** An effective (resolved) value with provenance for audit/debug. */
export interface EffectiveValue {
  value: unknown;
  /** The level that ultimately set the value. */
  source: ConfigLevel;
  locked: boolean;
}

/**
 * Resolve effective config by walking the chain from least- to most-specific.
 * More-specific levels override, unless a key was locked by an ancestor.
 * (Reference resolver; the service-side resolver adds caching + audit — docs/architecture/27 §7.)
 */
export function resolveEffectiveConfig(chain: ConfigNode[]): Record<string, EffectiveValue> {
  const ordered = [...chain].sort((a, b) => configLevelRank(a.level) - configLevelRank(b.level));
  const effective: Record<string, EffectiveValue> = {};
  const locked = new Set<string>();

  for (const node of ordered) {
    for (const [key, value] of Object.entries(node.values)) {
      if (locked.has(key)) continue; // an ancestor locked this key
      effective[key] = { value, source: node.level, locked: node.lockedKeys.includes(key) };
    }
    for (const key of node.lockedKeys) locked.add(key);
  }
  return effective;
}
