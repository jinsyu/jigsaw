// Before the E2E run: the local test teachers of the teacher screens exist in the local stack
// (scripts/lib/local-teacher.mjs; stacks seeded before T21 lack them).
import { ensureLocalTeachers } from '../../scripts/lib/local-teacher.mjs';

export default async function globalSetup() {
  await ensureLocalTeachers();
}
