// Help settings (spec rule 10): DB row <-> Hints, the POST /api/sessions body and the
// teacher wording.
import { describe, expect, it } from 'vitest';
import { DEFAULT_HINTS, hintsFromSession } from '../../public/js/store/puzzle-store.js';
import { createSession } from '../../public/js/teacher/data.js';
import { HINT_OPTIONS, hintsSummary, onOffLabel } from '../../public/js/teacher/format.js';

function fakeApi() {
  const calls = [];
  return {
    calls,
    post: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, sessionId: 's1', code: '123456' };
    },
  };
}

describe('hintsFromSession', () => {
  it('maps the hint_* columns to Hints', () => {
    const row = { hint_preview: true, hint_outline: false, hint_picture_button: false, hint_underlay: true };
    expect(hintsFromSession(row)).toEqual({ preview: true, outline: false, pictureButton: false, underlay: true });
  });

  it('uses the defaults for missing or non-boolean columns', () => {
    expect(hintsFromSession({})).toEqual(DEFAULT_HINTS);
    expect(hintsFromSession(null)).toEqual(DEFAULT_HINTS);
    expect(hintsFromSession({ hint_preview: 'yes', hint_outline: null })).toEqual(DEFAULT_HINTS);
  });
});

describe('createSession', () => {
  it('sends all four help settings, with the defaults when none are given', async () => {
    const api = fakeApi();
    const created = await createSession(api, { picture: { builtinKey: 'sea', aspect: 1.5, title: '바다' }, pieceCount: 24, groupCount: 3 });
    expect(created).toEqual({ sessionId: 's1', code: '123456' });
    expect(api.calls[0]).toEqual({
      path: '/api/sessions',
      body: {
        pieceCount: 24,
        groupCount: 3,
        picture: { builtinKey: 'sea' },
        hints: { preview: false, outline: true, pictureButton: true, underlay: false },
      },
    });
  });

  it('sends the teacher choice', async () => {
    const api = fakeApi();
    await createSession(api, {
      picture: { imageId: 'abc', width: 720, height: 480 },
      pieceCount: 12,
      groupCount: 1,
      hints: { preview: true, outline: false, pictureButton: false, underlay: true },
    });
    expect(api.calls[0].body).toEqual({
      pieceCount: 12,
      groupCount: 1,
      picture: { imageId: 'abc' },
      hints: { preview: true, outline: false, pictureButton: false, underlay: true },
    });
  });
});

describe('teacher wording', () => {
  it('has one switch per help setting, in a fixed order', () => {
    expect(HINT_OPTIONS.map((o) => o.key)).toEqual(Object.keys(DEFAULT_HINTS));
    for (const o of HINT_OPTIONS) {
      expect(o.label).toBeTruthy();
      expect(o.help).toBeTruthy();
      expect(o.short).toBeTruthy();
    }
  });

  it('summarises the settings that are on', () => {
    expect(hintsSummary(DEFAULT_HINTS)).toBe('도움: 조각 윤곽선 · 완성 그림 버튼');
    expect(hintsSummary({ preview: true, outline: true, pictureButton: true, underlay: true })).toBe(
      '도움: 칸 미리 보기 · 조각 윤곽선 · 완성 그림 버튼 · 흐린 밑그림',
    );
    expect(hintsSummary({ preview: false, outline: false, pictureButton: false, underlay: false })).toBe('도움: 모두 꺼짐');
  });

  it('says on and off in Korean', () => {
    expect(onOffLabel(true)).toBe('켜짐');
    expect(onOffLabel(false)).toBe('꺼짐');
  });
});
