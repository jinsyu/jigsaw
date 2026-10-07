// Student entry (/join, /play): code -> name -> anonymous sign-in -> join_session -> waiting.
// Loaded on demand by js/app.js. The puzzle itself is connected in T11; until then /play
// shows the waiting screen in its "started" state and never opens the solo demo.
import { isConfigured, pickConfig } from '../config.js';
import { normalizeCode } from '../routes.js';
import { getStudentClient } from '../supabase-client.js';
import { connectClass } from './live.js';
import { normalizeName } from './names.js';
import { clearSaved, readSaved, writeSaved } from './saved.js';
import { renderCodeStep, renderLoading, renderMessage, renderNameStep, renderWaiting } from './views.js';

const NETWORK_ERROR = /fetch|network|load failed/i;

const MESSAGES = {
  invalid_code: '코드를 다시 확인해 주세요',
  too_many_attempts: '코드를 여러 번 틀렸어요. 1분 뒤에 다시 넣어 주세요.',
  network: '인터넷 연결을 확인하고 다시 눌러 주세요.',
  failed: '들어가지 못했어요. 잠시 뒤 다시 눌러 주세요.',
};

class JoinError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function reasonOf(error) {
  if (error instanceof JoinError) return error.reason;
  const text = `${error?.message ?? ''} ${error?.name ?? ''}`;
  return NETWORK_ERROR.test(text) || error?.status === 0 ? 'network' : 'failed';
}

async function anonymousUser(client, { fresh = false } = {}) {
  if (!fresh) {
    const { data } = await client.auth.getSession();
    if (data.session?.user?.is_anonymous) return data.session.user;
  }
  await client.auth.signOut({ scope: 'local' }).catch(() => {});
  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw error;
  return data.user;
}

// join_session with the device's anonymous account; a fresh account if the old one was
// deleted when an earlier class ended (account_gone, T4 review).
async function joinClass(client, code) {
  let user = await anonymousUser(client);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await client.rpc('join_session', { p_code: code });
    if (error) {
      // An expired or revoked token: start over with a new anonymous account once.
      if (attempt === 0 && (error.code === '42501' || error.status === 401)) {
        user = await anonymousUser(client, { fresh: true });
        continue;
      }
      throw error;
    }
    if (data?.ok) return { user, result: data };
    if (data?.error === 'account_gone' && attempt === 0) {
      user = await anonymousUser(client, { fresh: true });
      continue;
    }
    throw new JoinError(data?.error === 'too_many_attempts' ? 'too_many_attempts' : 'invalid_code');
  }
  throw new JoinError('failed');
}

export function startStudent(main, route) {
  const config = pickConfig(location.hostname);
  if (!isConfigured(config)) {
    renderMessage(main, {
      title: '아직 들어갈 수 없어요',
      text: '학생 입장은 준비 중이에요. 선생님께 알려 주세요.',
    });
    return;
  }
  const flow = new StudentFlow(main, config);
  const saved = readSaved(localStorage);
  const code = normalizeCode(new URLSearchParams(location.search).get('code'));

  if (route === 'play') {
    if (saved) flow.resume(saved);
    else {
      renderMessage(main, {
        title: '들어간 수업이 없어요',
        text: '선생님이 알려 준 코드를 넣고 들어와 주세요.',
        action: { href: '/', label: '코드 넣으러 가기' },
      });
    }
    return;
  }
  if (code.length === 6 && saved?.code === code) flow.resume(saved);
  else if (code.length === 6) flow.askName(code);
  else flow.askCode('');
}

class StudentFlow {
  constructor(main, config) {
    this.main = main;
    this.config = config;
    this.pendingName = '';
    this.live = null;
    this.waiting = null;
    this.name = '';
    // Start downloading supabase-js while the student types.
    this.clientPromise = getStudentClient(config);
    this.clientPromise.catch(() => {});
  }

  askCode(code, error = '') {
    this.setAddress('/join' + (code ? `?code=${code}` : ''));
    renderCodeStep(this.main, {
      code,
      error,
      onSubmit: (next) => {
        if (this.pendingName) this.enter(next, this.pendingName);
        else this.askName(next);
      },
    });
  }

  askName(code) {
    this.setAddress(`/join?code=${code}`);
    renderNameStep(this.main, {
      code,
      name: this.pendingName,
      onBack: () => this.askCode(code),
      onSubmit: async (value) => {
        const name = normalizeName(value);
        if (!name) return '이름을 넣어 주세요.';
        return this.enter(code, name);
      },
    });
  }

  // Returns an error message for the name step, or '' once the student is in.
  async enter(code, name) {
    this.pendingName = name;
    const fromCodeStep = !this.main.querySelector('.st-name-form');
    if (fromCodeStep) renderLoading(this.main, '들어가는 중이에요…');
    try {
      const client = await this.clientPromise;
      const { user, result } = await joinClass(client, code);
      writeSaved(localStorage, { name, code, sessionId: result.session_id, memberId: result.member_id });
      this.pendingName = '';
      this.openClass(client, { code, name, userId: user.id, sessionId: result.session_id, memberId: result.member_id, status: result.status });
      return '';
    } catch (error) {
      const reason = reasonOf(error);
      if (reason !== 'network' && reason !== 'failed') {
        console.warn('join refused:', reason);
        this.askCode(code, MESSAGES[reason]);
        return '';
      }
      console.error(error);
      if (fromCodeStep) this.askCode(code, MESSAGES[reason]);
      return MESSAGES[reason];
    }
  }

  // Same device again: same anonymous account, so join_session returns the same members row.
  async resume(saved) {
    renderLoading(this.main, '다시 들어가는 중이에요…');
    try {
      const client = await this.clientPromise;
      const { user, result } = await joinClass(client, saved.code);
      writeSaved(localStorage, { ...saved, sessionId: result.session_id, memberId: result.member_id });
      this.openClass(client, { ...saved, userId: user.id, sessionId: result.session_id, memberId: result.member_id, status: result.status });
    } catch (error) {
      const reason = reasonOf(error);
      if (reason === 'invalid_code') {
        clearSaved(localStorage);
        this.ended('이 수업은 끝났어요');
        return;
      }
      console.error(error);
      renderMessage(this.main, {
        title: '다시 들어가지 못했어요',
        text: MESSAGES[reason === 'too_many_attempts' ? 'too_many_attempts' : 'network'],
        action: { label: '다시 시도' },
        onAction: () => this.resume(saved),
      });
    }
  }

  openClass(client, { code, name, userId, sessionId, memberId, status }) {
    this.live?.stop();
    this.showStatus(status, code);
    this.waiting = renderWaiting(this.main, { onRename: () => this.rename(code) });
    this.name = name;
    this.live = connectClass({
      client,
      sessionId,
      memberId,
      userId,
      name,
      onChange: (state) => {
        this.showStatus(state.status, code);
        this.waiting?.(state);
      },
      onEnded: () => {
        clearSaved(localStorage);
        this.live = null;
        this.ended('수업이 끝났어요');
      },
    });
  }

  // /join?code= while waiting, /play once the puzzles have started (T11 puts the puzzle there).
  showStatus(status, code) {
    this.setAddress(status === 'playing' ? '/play' : `/join?code=${code}`);
  }

  rename(code) {
    renderNameStep(this.main, {
      code,
      name: this.name,
      mode: 'rename',
      onBack: () => this.redrawWaiting(code),
      onSubmit: async (value) => {
        const name = normalizeName(value);
        if (!name) return '이름을 넣어 주세요.';
        const saved = readSaved(localStorage);
        if (saved) writeSaved(localStorage, { ...saved, name });
        this.name = name;
        this.redrawWaiting(code);
        return '';
      },
    });
  }

  redrawWaiting(code) {
    this.waiting = renderWaiting(this.main, { onRename: () => this.rename(code) });
    this.live?.rename(this.name); // tracks the name again and draws the current state
  }

  ended(title) {
    this.waiting = null;
    renderMessage(this.main, {
      title,
      text: '함께해 줘서 고마워요! 새 수업은 선생님이 알려 주는 코드로 들어와요.',
      tone: 'ended',
    });
  }

  setAddress(path) {
    if (location.pathname + location.search !== path) history.replaceState(null, '', path);
  }
}
