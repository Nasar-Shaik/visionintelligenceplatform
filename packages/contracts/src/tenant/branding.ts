/**
 * Tenant branding (P-5.3, mid-milestone requirement 6) — **reserved, and deliberately narrow.**
 *
 * A tenant may put its name and mark on the product, and may set the accent colour. That is the
 * whole surface, and the narrowness is the design.
 *
 * ### ⚠️ Severity and status colours are not themeable, and never will be
 *
 * DESIGN_SYSTEM v2 §12 reserves colour for meaning: `critical` is red everywhere, on every screen,
 * for every customer. A tenant that could restyle severity could make critical look calm — and the
 * operator who learns "red means act" at one site would be wrong at another. The whole value of
 * reserving colour for meaning is that the meaning belongs to the platform, not to the deployment.
 *
 * So exactly one colour is overridable (`--color-brand` and its companions), and the override is
 * **validated for contrast** against the surface ramp before it is applied. An unreadable brand
 * colour is a support ticket at best and an unnoticed alert at worst, so a failing override falls
 * back to the default and is reported rather than rendered.
 *
 * ⚠️ A `ReportThemeId` is **not** this. That styles a generated PDF, lives in the reporting
 * contract, and shares no tokens with the console — wiring them together would let a console accent
 * silently restyle a document handed to a regulator.
 */
import { z } from 'zod';
import { IsoDateTime, TenantId } from '../common/primitives.js';

export const TenantBranding = z.object({
  tenantId: TenantId,
  /** Shown in the top bar and on exported reports. The tenant's own name for itself. */
  companyName: z.string().min(1).max(120),
  /**
   * The tenant's mark, as a **storage key** — never a URL. A stored URL points outside the
   * platform's control: it can be swapped, it can be a tracking pixel on every page load, and it
   * breaks when the far end moves.
   */
  logoStorageKey: z.string().min(1).max(500).optional(),
  /**
   * The accent, in the platform's `oklch(L C H)` token form. ⚠️ Applied only if it passes contrast
   * validation; a failing value is reported and the default is used.
   */
  primaryColor: z
    .string()
    .regex(/^oklch\(\s*[\d.]+\s+[\d.]+\s+[\d.]+\s*\)$/, 'must be oklch(L C H)')
    .optional(),
  /** Which theme the tenant's operators start in. They may still switch. */
  defaultTheme: z.enum(['dark', 'light']).default('dark'),
  updatedAt: IsoDateTime,
});
export type TenantBranding = z.infer<typeof TenantBranding>;

/**
 * ⚠️ **Tokens a tenant may never override.** Exported as data so the list is greppable and a test
 * can assert it, rather than living in a comment somebody edits.
 */
export const UNBRANDABLE_TOKENS = [
  'color-sev-critical',
  'color-sev-high',
  'color-sev-medium',
  'color-sev-low',
  'color-sev-info',
  'color-status-ok',
  'color-status-warn',
  'color-status-error',
  'color-status-idle',
  'color-critical',
  'color-warning',
  'color-success',
] as const;

/** The only tokens branding may set. */
export const BRANDABLE_TOKENS = ['color-brand', 'color-brand-muted', 'color-brand-border'] as const;
