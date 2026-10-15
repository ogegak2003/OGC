import { configure } from '@testing-library/react';

// Pages are lazy-loaded; when the whole monorepo's tests run in parallel on a busy machine,
// the default 1 s for `findBy…` queries is too short. Real assertions are unchanged.
configure({ asyncUtilTimeout: 5_000 });
