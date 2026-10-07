// Where the rt server started by Playwright (playwright.config.js, scripts/rt-dev.mjs) writes its
// output, so the tests can check that no student name is logged (spec D14).
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RT_LOG_FILE = join(tmpdir(), 'jigsaw-e2e-rt-server.log');
