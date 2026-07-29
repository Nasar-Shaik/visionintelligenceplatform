import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { FoundationReady } from './FoundationReady';
import { renderWithProviders } from '@/test/render';

describe('FoundationReady', () => {
  it('mounts inside the full provider stack (store + query + router)', async () => {
    renderWithProviders(<FoundationReady />);

    expect(screen.getByRole('heading', { name: /operations console/i })).toBeInTheDocument();
    // Query provider resolved the local health query.
    expect(await screen.findByText(/query:ok/i)).toBeInTheDocument();
    // Redux store default theme surfaced.
    expect(screen.getByText(/theme:dark/i)).toBeInTheDocument();
  });
});
