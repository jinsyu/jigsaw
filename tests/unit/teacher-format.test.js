import { describe, expect, it } from 'vitest';
import { RtError } from '../../public/js/rt-client.js';
import {
  GROUP_COUNT,
  clampGroupCount,
  createErrorMessage,
  formatCode,
  formatDateTime,
  piecesPerStudentNote,
  sessionSummary,
  statusLabel,
} from '../../public/js/teacher/format.js';

describe('formatCode', () => {
  it('splits the six digits in two groups for reading aloud', () => {
    expect(formatCode('482913')).toBe('482 913');
    expect(formatCode('007001')).toBe('007 001');
  });
});

describe('piecesPerStudentNote', () => {
  it('shows an even share', () => {
    expect(piecesPerStudentNote(24)).toBe('모둠이 4명이면 한 사람에게 6조각씩 나눠 줘요.');
    expect(piecesPerStudentNote(12)).toBe('모둠이 4명이면 한 사람에게 3조각씩 나눠 줘요.');
  });
  it('shows a range when the pieces do not divide evenly', () => {
    expect(piecesPerStudentNote(70)).toBe('모둠이 4명이면 한 사람에게 17~18조각씩 나눠 줘요.');
    expect(piecesPerStudentNote(48, 5)).toBe('모둠이 5명이면 한 사람에게 9~10조각씩 나눠 줘요.');
  });
});

describe('clampGroupCount', () => {
  it('keeps the count inside what create_session accepts', () => {
    expect(GROUP_COUNT).toEqual({ min: 1, max: 12, initial: 6 });
    expect(clampGroupCount(0)).toBe(1);
    expect(clampGroupCount(13)).toBe(12);
    expect(clampGroupCount('7')).toBe(7);
    expect(clampGroupCount('')).toBe(6);
    expect(clampGroupCount(4.6)).toBe(5);
  });
});

describe('sessionSummary and statusLabel', () => {
  it('reads like the mockup pill', () => {
    expect(sessionSummary({ title: '바다 친구들', pieceCount: 24, groupCount: 6 })).toBe('바다 친구들 · 24조각 · 6모둠');
  });
  it('names each session state', () => {
    expect(statusLabel('waiting')).toBe('학생 기다리는 중');
    expect(statusLabel('playing')).toBe('퍼즐 하는 중');
    expect(statusLabel('ended')).toBe('끝난 수업');
  });
});

describe('formatDateTime', () => {
  it('uses Korean month, day and time', () => {
    expect(formatDateTime('2026-10-07T05:30:00Z', 'Asia/Seoul')).toBe('10월 7일 오후 2:30');
  });
});

describe('createErrorMessage', () => {
  it.each([
    [new RtError('invalid_token', 401), '선생님 계정으로 다시 로그인해 주세요.'],
    [new RtError('not_teacher', 403), '선생님 계정으로 다시 로그인해 주세요.'],
    [new RtError('invalid_picture', 400), '그림을 다시 골라 주세요.'],
    [new RtError('too_many_sessions', 429), '열린 수업이 너무 많아요. 끝난 수업을 닫은 뒤 다시 눌러 주세요.'],
    [new RtError('no_free_code', 503), '지금은 수업 코드를 만들 수 없어요. 잠시 뒤 다시 눌러 주세요.'],
    [new RtError('network'), '인터넷 연결을 확인하고 다시 눌러 주세요.'],
    [new RtError('server_error', 500), '수업을 열지 못했어요. 잠시 뒤 다시 눌러 주세요.'],
  ])('%s', (error, text) => {
    expect(createErrorMessage(error)).toBe(text);
  });
});
