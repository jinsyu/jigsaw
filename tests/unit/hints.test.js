// Help settings (spec rule 10): DB row <-> Hints, the create_session arguments and the
// teacher wording.
import { describe, expect, it } from 'vitest';
import { DEFAULT_HINTS, hintsFromSession } from '../../public/js/store/puzzle-store.js';
import { createSession } from '../../public/js/teacher/data.js';
import { HINT_OPTIONS, hintsSummary, onOffLabel } from '../../public/js/teacher/format.js';

function fakeClient() {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: { id: 1 }, error: null };
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
    const client = fakeClient();
    await createSession(client, { picture: { builtinKey: 'sea', aspect: 1.5 }, pieceCount: 24, groupCount: 3 });
    expect(client.calls[0]).toEqual({
      name: 'create_session',
      args: {
        p_piece_count: 24,
        p_group_count: 3,
        p_builtin_key: 'sea',
        p_aspect: 1.5,
        p_hint_preview: false,
        p_hint_outline: true,
        p_hint_picture_button: true,
        p_hint_underlay: false,
      },
    });
  });

  it('sends the teacher choice', async () => {
    const client = fakeClient();
    await createSession(client, {
      picture: { imageId: 'abc' },
      pieceCount: 12,
      groupCount: 1,
      hints: { preview: true, outline: false, pictureButton: false, underlay: true },
    });
    expect(client.calls[0].args).toEqual({
      p_piece_count: 12,
      p_group_count: 1,
      p_image_id: 'abc',
      p_hint_preview: true,
      p_hint_outline: false,
      p_hint_picture_button: false,
      p_hint_underlay: true,
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
