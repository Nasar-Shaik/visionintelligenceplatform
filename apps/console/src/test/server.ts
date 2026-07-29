import { setupServer } from 'msw/node';
import { handlers } from './handlers';

/** MSW node server used across the test suite; started/stopped in test/setup.ts. */
export const server = setupServer(...handlers);
