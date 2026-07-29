import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './button';
import { Badge } from './badge';
import { SeverityBadge } from './soc/severity-badge';
import { StatusIndicator } from './soc/status-indicator';
import { IncidentCard } from './soc/incident-card';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './dialog';

describe('Button', () => {
  it('renders variants and disables while loading', () => {
    const { rerender } = render(<Button variant="destructive">Delete</Button>);
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    rerender(<Button loading>Saving</Button>);
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
  });

  it('renders as a child element with asChild', () => {
    render(
      <Button asChild>
        <a href="/x">Go</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Go' });
    expect(link).toHaveAttribute('href', '/x');
  });
});

describe('Badge', () => {
  it('applies the critical variant', () => {
    render(<Badge variant="critical">Down</Badge>);
    expect(screen.getByText('Down').className).toContain('text-critical');
  });
});

describe('SeverityBadge', () => {
  it('labels every severity (never colour-only)', () => {
    render(
      <>
        <SeverityBadge severity="critical" />
        <SeverityBadge severity="info" dot />
      </>,
    );
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getByText('Info')).toBeInTheDocument();
  });
});

describe('StatusIndicator', () => {
  it('exposes an accessible name when the label is visually hidden', () => {
    render(<StatusIndicator status="error" label="" />);
    expect(screen.getByRole('img', { name: 'Error' })).toBeInTheDocument();
  });
});

describe('IncidentCard', () => {
  it('shows severity, status, camera and actions', () => {
    render(
      <IncidentCard
        title="Intrusion — Zone A"
        severity="critical"
        status="raised"
        cameraName="Dock 3"
        at={Date.now()}
        actions={<Button size="sm">Acknowledge</Button>}
      />,
    );
    expect(screen.getByText('Intrusion — Zone A')).toBeInTheDocument();
    expect(screen.getByText('Raised')).toBeInTheDocument();
    expect(screen.getByText('Dock 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
  });
});

describe('Dialog', () => {
  it('opens on trigger and shows content', async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Resolve incident</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByText('Resolve incident')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('Resolve incident')).toBeInTheDocument();
  });
});
