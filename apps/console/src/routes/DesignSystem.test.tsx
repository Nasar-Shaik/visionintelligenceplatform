import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { DesignSystem } from './DesignSystem';
import { renderWithProviders } from '@/test/render';

describe('DesignSystem gallery', () => {
  it('mounts every primitive + composite section without error', () => {
    renderWithProviders(<DesignSystem />);
    expect(screen.getByRole('heading', { name: 'Design System', level: 1 })).toBeInTheDocument();
    // A representative composite from a few sections renders.
    expect(screen.getByText('Active incidents')).toBeInTheDocument();
    expect(screen.getByText('Intrusion detected — Zone A')).toBeInTheDocument();
    expect(screen.getByText('Runtime health')).toBeInTheDocument();
  });
});
