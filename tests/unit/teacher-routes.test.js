import { describe, expect, it } from 'vitest';
import { parseTeacherPath, sessionPath, teacherReturnPath } from '../../public/js/teacher/routes.js';

describe('parseTeacherPath', () => {
  it.each([
    ['/teacher', { view: 'home' }],
    ['/teacher/', { view: 'home' }],
    ['/teacher/new', { view: 'new' }],
    ['/teacher/images', { view: 'images' }],
    ['/teacher/sessions/42', { view: 'session', sessionId: 42 }],
    ['/teacher/sessions/42/', { view: 'session', sessionId: 42 }],
    ['/teacher/sessions/0', { view: 'notFound' }],
    ['/teacher/sessions/abc', { view: 'notFound' }],
    ['/teacher/sessions/99999999999999999999', { view: 'notFound' }],
    ['/teacher/other', { view: 'notFound' }],
  ])('%s', (path, expected) => {
    expect(parseTeacherPath(path)).toEqual(expected);
  });

  it('builds the lobby path of a session', () => {
    expect(sessionPath(7)).toBe('/teacher/sessions/7');
  });
});

describe('teacherReturnPath', () => {
  it.each([
    ['/teacher/sessions/42', '', '/teacher/sessions/42'],
    ['/teacher/new', '?code=abc&state=x', '/teacher/new'],
    ['/teacher/images', '?tab=mine&error=1', '/teacher/images?tab=mine'],
    ['/teacher', '', '/teacher'],
    ['/join', '?code=123456', '/teacher'],
    ['//evil.example/teacher', '', '/teacher'],
    ['/teacher/../join', '', '/teacher'],
  ])('%s%s -> %s', (path, search, expected) => {
    expect(teacherReturnPath(path, search)).toBe(expected);
  });
});
