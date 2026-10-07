// Student entry (/join, /play): code -> name -> POST /api/join (rt server) -> the class socket
// (student/live.js) -> waiting, then the group puzzle once the class has started and the
// student is in a group (student/puzzle.js). No Supabase and no account: the rt server gives a
// student token, kept with the name under the class code on this device (saved.js).
// Loaded on demand by js/app.js. /play never opens the solo demo.
import { hasRtServer, pickConfig } from '../config.js';
import { normalizeCode } from '../routes.js';
import { RtError, rtRequest } from '../rt-client.js';
import { connectClass } from './live.js';
import { normalizeName } from './names.js';
import { openPuzzle } from './puzzle.js';
import { clearSaved, latestSaved, readSaved, writeSaved } from './saved.js';
import { renderCodeStep, renderLoading, renderMessage, renderNameStep, renderWaiting } from './views.js';

export const MESSAGES = {
  invalid_code: '코드를 다시 확인해 주세요',
  too_many_attempts: '코드를 여러 번 틀렸어요. 잠시 뒤에 다시 입력해 주세요.',
  invalid_name: '이름을 넣어 주세요.',
  class_full: '이 수업은 자리가 다 찼어요. 선생님께 알려 주세요.',
  network: '인터넷 연결을 확인하고 다시 눌러 주세요.',
  failed: '들어가지 못했어요. 잠시 뒤 다시 눌러 주세요.',
};

// RtError code -> MESSAGES key.
export function joinReason(error) {
  const code = error instanceof RtError ? error.code : 'failed';
  return Object.hasOwn(MESSAGES, code) ? code : 'failed';
}

// POST /api/join. With the token this device got before, the server returns the same member
// (and takes the name again: a rename, or the name after a server restart).
function join(rtUrl, { code, name, token }) {
  return rtRequest(rtUrl, '/api/join', { method: 'POST', json: token ? { code, name, token } : { code, name } });
}

export function startStudent(main, route) {
  const config = pickConfig(location.hostname);
  if (!hasRtServer(config)) {
    renderMessage(main, {
      title: '아직 들어갈 수 없어요',
      text: '학생 입장은 준비 중이에요. 선생님께 알려 주세요.',
    });
    return;
  }
  const flow = new StudentFlow(main, config.rtUrl);
  const code = normalizeCode(new URLSearchParams(location.search).get('code'));

  if (route === 'play') {
    const saved = latestSaved(localStorage);
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
  const saved = code.length === 6 ? readSaved(localStorage, code) : null;
  if (saved) flow.resume(saved);
  else if (code.length === 6) flow.askName(code);
  else flow.askCode('');
}

class StudentFlow {
  constructor(main, rtUrl) {
    this.main = main;
    this.rtUrl = rtUrl;
    this.pendingName = '';
    this.live = null;
    this.room = null; // { code, name, token }
    this.waiting = null; // update function of the waiting screen
    this.puzzle = null; // puzzle.js handle while a puzzle is open or opening
    this.connected = true;
  }

  askCode(code, error = '') {
    this.setAddress('/join' + (code ? `?code=${code}` : ''));
    renderCodeStep(this.main, {
      code,
      error,
      onSubmit: (next) => {
        const saved = readSaved(localStorage, next);
        if (saved) this.resume(saved);
        else if (this.pendingName) this.enter(next, this.pendingName);
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
        if (!name) return MESSAGES.invalid_name;
        return this.enter(code, name);
      },
    });
  }

  // Returns an error message for the name step, or '' once the student is in.
  async enter(code, name) {
    this.pendingName = name;
    const fromCodeStep = !this.main.querySelector('.st-name-form');
    if (fromCodeStep) renderLoading(this.main, '들어가는 중이에요…');
    const token = readSaved(localStorage, code)?.token;
    try {
      const answer = await join(this.rtUrl, { code, name, token });
      writeSaved(localStorage, { name, code, token: answer.token });
      this.pendingName = '';
      this.openClass({ code, name, token: answer.token, memberId: answer.memberId });
      return '';
    } catch (error) {
      const reason = joinReason(error);
      // A token this device kept for a class that is gone (plan memo T22).
      if (reason === 'invalid_code' && token) clearSaved(localStorage, code);
      if (reason === 'invalid_code' || reason === 'too_many_attempts') {
        console.warn('join refused:', reason);
        this.askCode(code, MESSAGES[reason]);
        return '';
      }
      if (reason === 'failed') console.error(error);
      if (fromCodeStep) this.askCode(code, MESSAGES[reason]);
      return MESSAGES[reason];
    }
  }

  // Same device again: straight back in with the saved token.
  resume(saved) {
    this.openClass(saved);
  }

  openClass({ code, name, token, memberId = null }) {
    this.live?.close();
    this.closePuzzle();
    this.waiting = null;
    this.room = { code, name, token };
    this.connected = true;
    renderLoading(this.main, '들어가는 중이에요…');
    this.live = connectClass({
      rtUrl: this.rtUrl,
      token,
      name,
      memberId,
      onChange: (state, change) => this.update(state, change),
      onConnection: (status) => this.setConnection(status),
      onEnded: () => this.finish(),
    });
  }

  setConnection(status) {
    const connected = status !== 'lost';
    if (connected === this.connected) return;
    this.connected = connected;
    const state = this.live?.model.state;
    if (!state?.ready) {
      renderLoading(this.main, connected ? '들어가는 중이에요…' : '연결이 끊겼어요. 다시 연결하는 중이에요…');
      return;
    }
    this.puzzle?.setConnected(connected);
    this.drawWaiting(state);
  }

  update(state, change) {
    if (!state.ready) return;
    this.setAddress(state.status === 'playing' ? '/play' : `/join?code=${this.room.code}`);
    const group = state.status === 'playing' ? state.me.group : null;
    if (group !== null && this.puzzle?.groupNumber === group) {
      if (change.board) this.puzzle.applyBoard(change.board, state.serverNow);
      if (change.events?.length) this.puzzle.applyEvents(change.events);
      this.puzzle.setMates(state.mates);
      return;
    }
    if (group !== null && change.board) return this.startPuzzle(state, change.board);
    // Waiting, without a group, or a puzzle about to open (its state is on the way).
    if (this.puzzle && group === null) this.closePuzzle();
    if (!this.puzzle) this.drawWaiting(state);
  }

  drawWaiting(state) {
    if (this.puzzle) return;
    if (!this.waiting) this.waiting = renderWaiting(this.main, { onRename: () => this.rename() });
    this.waiting({
      name: state.me.name,
      code: this.room.code,
      status: state.status,
      group: state.me.group === null ? null : { number: state.me.group },
      myColor: state.me.color,
      mates: state.mates,
      connected: this.connected,
    });
  }

  // A move to another group closes the old puzzle first.
  startPuzzle(state, board) {
    this.closePuzzle();
    this.waiting = null;
    renderLoading(this.main, '퍼즐을 여는 중이에요…');
    const handle = openPuzzle({
      main: this.main,
      live: this.live,
      setup: state.setup,
      memberId: state.me.memberId,
      groupNumber: state.me.group,
      mates: state.mates,
      board,
      serverNow: state.serverNow,
    });
    this.puzzle = handle;
    handle.setConnected(this.connected);
    handle.ready.catch((error) => {
      if (this.puzzle !== handle) return;
      console.error(error);
      this.closePuzzle();
      renderMessage(this.main, {
        title: '퍼즐을 열지 못했어요',
        text: '인터넷 연결을 확인하고 다시 눌러 주세요.',
        action: { label: '다시 시도' },
        onAction: () => this.live?.sync(),
      });
    });
  }

  closePuzzle() {
    this.puzzle?.dispose();
    this.puzzle = null;
  }

  finish() {
    const wasIn = this.live?.model.state.ready === true;
    this.live?.close();
    this.live = null;
    this.closePuzzle();
    if (this.room) clearSaved(localStorage, this.room.code);
    this.ended(wasIn ? '수업이 끝났어요' : '이 수업은 끝났어요');
  }

  rename() {
    const { code } = this.room;
    renderNameStep(this.main, {
      code,
      name: this.room.name,
      mode: 'rename',
      onBack: () => this.redrawWaiting(),
      onSubmit: async (value) => {
        const name = normalizeName(value);
        if (!name) return MESSAGES.invalid_name;
        try {
          await join(this.rtUrl, { code, name, token: this.room.token });
        } catch (error) {
          const reason = joinReason(error);
          if (reason === 'failed') console.error(error);
          return MESSAGES[reason === 'invalid_code' ? 'failed' : reason];
        }
        writeSaved(localStorage, { name, code, token: this.room.token });
        this.room.name = name;
        this.live?.rename(name);
        this.redrawWaiting();
        return '';
      },
    });
  }

  redrawWaiting() {
    this.waiting = null;
    const state = this.live?.model.state;
    if (state?.ready) this.update(state, {});
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
