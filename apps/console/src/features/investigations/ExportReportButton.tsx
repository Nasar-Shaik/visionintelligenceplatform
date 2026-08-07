/**
 * Download the export report (P-8.6, priority 6).
 *
 * ⛔ **The endpoint, the API client method and the React hook all existed already.** `report()` has
 * been in `investigationsApi` since slice 7 and `useReport()` in this feature since the same day;
 * the P-8.5 audit found that **no component called either**. This is the button, and nothing else.
 *
 * ⚠️ **Fetched on click, never on render.** A report is assembled from the timeline and the incident
 * service on every request, so prefetching one for a page that may never export costs a customer's
 * deployment a fan-out per page view.
 */
import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/ui';
import { investigationsApi } from '@/lib/api/investigations';

export interface ExportReportButtonProps {
  analysisId: string;
  sessionId: string | undefined;
  label: string | undefined;
  disabled: boolean;
}

export function ExportReportButton({
  analysisId,
  sessionId,
  label,
  disabled,
}: ExportReportButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function download(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const report = await investigationsApi.report(analysisId, sessionId);
      /*
       * ⚠️ Serialised from the parsed contract, not from a raw response body. What lands on the
       * customer's disk is then exactly what this console validated and displayed — an export that
       * could contain fields the page rejected would be a second, unreviewed source of truth.
       */
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      /* ⭐ Named for the RUN, not the recording: two runs of one file are two different answers. */
      a.download = `${safeName(label ?? analysisId)}-${(sessionId ?? 'latest').slice(-8)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      /* ⛔ Said out loud. A download that silently does nothing is indistinguishable from a browser
       * blocking it, and the customer will retry forever. */
      setError(err instanceof Error ? err.message : 'the report could not be generated');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        disabled={disabled || busy}
        onClick={() => void download()}
        title={
          disabled
            ? 'Available once a run has finished'
            : 'Downloads the full record of this run: source, provenance, counts, findings, tracks and incidents'
        }
      >
        {busy ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Download className="mr-2 h-4 w-4" />
        )}
        Export report
      </Button>
      {error === undefined ? null : <p className="text-2xs text-destructive">{error}</p>}
    </div>
  );
}

/** ⚠️ Filenames only — a label is operator-supplied text and reaches the filesystem. */
function safeName(value: string): string {
  return value.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'analysis';
}
