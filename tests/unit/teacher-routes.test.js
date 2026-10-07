import { describe, expect, it } from 'vitest';
import { parseTeacherPath, sessionPath } from '../../public/js/teacher/routes.js';

const ID = '3f2b8c1e-7a4d-4e9b-9c2a-1b2c3d4e5f60';

describe('parseTeacherPath', () => {
  it.each([
    ['/teacher', { view: 'home' }],
    ['/teacher/', { view: 'home' }],
    ['/teacher/new', { view: 'new' }],
    ['/teacher/images', { view: 'images' }],
    [`/teacher/sessions/${ID}`, { view: 'session', sessionId: ID }],
    [`/teacher/sessions/${ID}/`, { view: 'session', sessionId: ID }],
    [`/teacher/sessions/${ID.toUpperCase()}`, { view: 'session', sessionId: ID }],
    ['/teacher/sessions/42', { view: 'notFound' }],
    ['/teacher/sessions/abc', { view: 'notFound' }],
    [`/teacher/sessions/${ID}x`, { view: 'notFound' }],
    ['/teacher/other', { view: 'notFound' }],
  ])('%s', (path, expected) => {
    expect(parseTeacherPath(path)).toEqual(expected);
  });

  it('builds the lobby path of a session', () => {
    expect(sessionPath(ID)).toBe(`/teacher/sessions/${ID}`);
  });
});
