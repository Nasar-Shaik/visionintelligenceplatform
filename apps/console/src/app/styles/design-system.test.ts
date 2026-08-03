/**
 * Design system enforcement (P-5.2.0, DESIGN_SYSTEM.md §10 and §22).
 *
 * The Architect's refinement asked for "Tailwind only · no Bootstrap · no Material UI". That was
 * already true — and true **by accident**: nothing recorded the policy and nothing checked it, so
 * `pnpm add @mui/material` would have succeeded and been reviewed as an ordinary dependency change.
 *
 * These tests are the difference between a rule and a preference. They read the console's real
 * `package.json` and its real token file, so they fail on the commit that breaks the policy rather
 * than in a review six weeks later.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const manifest = JSON.parse(read('../../../package.json')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const theme = read('./theme.css');

const declared = { ...manifest.dependencies, ...manifest.devDependencies };

/**
 * ⚠️ Component-CSS frameworks. Each one brings its own tokens, its own reset and its own opinion
 * about spacing — which is how a product ends up with two design systems and pages that belong to
 * neither.
 */
const FORBIDDEN_FRAMEWORKS = [
  'bootstrap',
  'react-bootstrap',
  '@mui/material',
  '@mui/base',
  '@material-ui/core',
  'antd',
  '@chakra-ui/react',
  '@mantine/core',
  'semantic-ui-react',
  'foundation-sites',
  'bulma',
  'styled-components',
  '@emotion/styled',
];

describe('§10 — Tailwind is the only styling framework', () => {
  it('⚠️ declares no forbidden component-CSS framework', () => {
    for (const framework of FORBIDDEN_FRAMEWORKS) {
      expect(Object.keys(declared), `${framework} is forbidden by DESIGN_SYSTEM §10`).not.toContain(
        framework,
      );
    }
  });

  it('declares the mandated stack', () => {
    for (const required of [
      'react',
      'tailwindcss',
      '@tanstack/react-query',
      '@reduxjs/toolkit',
      'react-hook-form',
      'zod',
      'lucide-react',
      'recharts',
      'class-variance-authority',
      'tailwind-merge',
    ]) {
      expect(Object.keys(declared), `${required} is part of the mandated stack`).toContain(
        required,
      );
    }
  });

  it('uses one icon set — mixing them is visible in a single toolbar', () => {
    for (const other of [
      'react-icons',
      '@heroicons/react',
      'feather-icons',
      '@tabler/icons-react',
    ]) {
      expect(Object.keys(declared)).not.toContain(other);
    }
    expect(Object.keys(declared)).toContain('lucide-react');
  });
});

describe('§10 — tokens are defined once, in theme.css', () => {
  it('defines the token families the design system depends on', () => {
    for (const token of [
      '--color-bg',
      '--color-surface-1',
      '--color-border',
      '--color-text',
      '--color-brand',
      '--color-success',
      '--color-warning',
      '--color-critical',
      '--radius-md',
      '--font-sans',
      '--motion-base',
    ]) {
      expect(theme, `${token} must be declared in theme.css`).toContain(token);
    }
  });

  /*
   * §12 — a badge never invents a vocabulary. Every severity in `EventPriority` has a token, so a
   * new enum value shows up as a missing token rather than as an unstyled string.
   */
  it('⚠️ carries one severity token per EventPriority value', () => {
    for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
      expect(theme).toContain(`--color-sev-${severity}`);
    }
  });

  /*
   * §21 — light is a variable swap with zero component changes. That only holds while every colour
   * resolves through a variable, which is what the `@theme` block guarantees.
   */
  it('keeps every colour behind a custom property, so a light theme is a swap', () => {
    expect(theme).toContain('@theme');
    expect(theme).toMatch(/--color-[a-z0-9-]+:/);
  });

  /*
   * §18 — one focus affordance, defined once. A component that rolls its own is a component whose
   * focus ring drifts from every other one.
   */
  it('defines the single focus affordance', () => {
    expect(theme).toContain('@utility focus-ring');
    expect(theme).toContain(':focus-visible');
  });

  /* §19 — reduced motion is honoured globally, not per component. */
  it('honours prefers-reduced-motion at the base layer', () => {
    expect(theme).toContain('prefers-reduced-motion');
  });
});
