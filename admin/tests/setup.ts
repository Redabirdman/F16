// Register jest-dom matchers on vitest's expect explicitly. The
// '@testing-library/jest-dom/vitest' convenience entry silently failed to
// extend the right expect instance under this pnpm layout ("Invalid Chai
// property: toBeInTheDocument"), so we extend by hand — same matchers,
// unambiguous target.
import * as matchers from '@testing-library/jest-dom/matchers';
import { expect } from 'vitest';

expect.extend(matchers);
