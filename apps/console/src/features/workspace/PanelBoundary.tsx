/**
 * A failure containment boundary around **one** workspace panel (P-5.7).
 *
 * ### ⚠️ Why this exists, and what it cost to find out
 *
 * The workspace renders up to seventeen independent panels side by side. Until P-5.7 a render error
 * in any one of them **unmounted the entire route**: React has no partial recovery without a
 * boundary, so an investigator opening an incident whose data tripped a single panel saw a blank
 * page — no footage, no timeline, no evidence, no notes, and nothing on screen explaining why.
 *
 * That is not hypothetical. It happened the first time the workspace was opened against a real
 * database: one incident document predating the `notes` field made the attachments panel throw, and
 * the whole investigation surface went white. Every test passed, because every test rendered panels
 * against fixtures that had the field.
 *
 * The point of a panel grid is that the panels are independent. This makes that structurally true:
 * one panel fails, one panel says so, the operator keeps the other sixteen.
 *
 * ⚠️ It reports **failed**, which is a distinct state from empty and from unavailable (DESIGN_SYSTEM
 * v2 §11). "Nothing here", "we could not find out" and "this panel is broken" are three different
 * sentences and an operator acts differently on each.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/ui';

interface Props {
  /** Named so the message can say *which* panel failed. */
  title: string;
  children: ReactNode;
}

interface State {
  error: Error | undefined;
}

export class PanelBoundary extends Component<Props, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    /*
     * ⚠️ Logged, never swallowed silently — a panel that fails quietly in production is a defect
     * nobody reports because the operator assumes the panel is simply empty. `console.error` is the
     * console's existing channel; no sensitive payload is included, only the component trace.
     */
    /* A panel that fails silently is a defect nobody reports — the operator assumes it is empty. */
    // eslint-disable-next-line no-console -- deliberate: see the note above
    console.error(
      `[workspace] panel "${this.props.title}" failed to render`,
      error,
      info.componentStack,
    );
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === undefined) return this.props.children;

    return (
      <div
        role="alert"
        data-testid="panel-failed"
        className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-critical/40 bg-critical/5 p-4 text-center"
      >
        <AlertTriangle className="size-5 text-critical" aria-hidden />
        <p className="text-xs font-medium text-text">This panel could not be displayed</p>
        {/*
          ⚠️ The message is shown. An investigator reporting "the evidence panel says X" gets the
          problem fixed; an investigator reporting "it went blank" does not.
        */}
        <p className="max-w-xs text-[11px] leading-relaxed text-text-subtle">
          {error.message || 'The panel raised an error while rendering.'} The rest of the workspace
          is unaffected.
        </p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => this.setState({ error: undefined })}
        >
          <RotateCcw className="mr-1 size-3" aria-hidden />
          Try this panel again
        </Button>
      </div>
    );
  }
}
