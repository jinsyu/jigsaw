// T19: limiters and teacher tokens of the rt server (pure, fake clock).
import { describe, expect, it } from 'vitest';
import { readConfig } from '../../server/src/config.js';
import {
  createConnectionCounter,
  createTokenBucket,
  createWindowLimiter,
  createWrongCodeGuard,
} from '../../server/src/limits.js';
import { clientAddress, proxiedAddress } from '../../server/src/sockets.js';
import { signTeacherToken, verifyTeacherToken } from '../../server/src/teacher-token.js';

function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

const SECRET = 'x'.repeat(40);

describe('teacher token', () => {
  it('서명한 토큰은 uid 로 풀리고, 만료·위조·다른 비밀값은 거부된다', () => {
    const now = clock();
    const token = signTeacherToken('teacher-1', SECRET, { now: now(), ttlMs: 1000 });
    expect(verifyTeacherToken(token, SECRET, now())).toBe('teacher-1');
    expect(verifyTeacherToken(token, 'y'.repeat(40), now())).toBeNull();
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ uid: 'teacher-2', exp: now() + 1000 })).toString('base64url');
    expect(verifyTeacherToken(`${forged}.${sig}`, SECRET, now())).toBeNull();
    expect(verifyTeacherToken(`${body}.${sig}.x`, SECRET, now())).toBeNull();
    expect(verifyTeacherToken(undefined, SECRET, now())).toBeNull();
    now.advance(1000);
    expect(verifyTeacherToken(token, SECRET, now())).toBeNull();
  });
});

describe('limiters', () => {
  it('창 단위 제한', () => {
    const now = clock();
    const limiter = createWindowLimiter({ limit: 2, windowMs: 1000, now });
    expect([limiter.hit('a'), limiter.hit('a'), limiter.hit('a'), limiter.hit('b')]).toEqual([true, true, false, true]);
    now.advance(1000);
    expect(limiter.hit('a')).toBe(true);
  });

  it('토큰 버킷: 초당 비율과 순간 허용량', () => {
    const now = clock();
    const bucket = createTokenBucket({ ratePerSecond: 2, burst: 3, now });
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
    now.advance(500);
    expect([bucket.take(), bucket.take()]).toEqual([true, false]);
  });

  it('틀린 코드가 한도를 넘으면 그 주소는 잠시 모든 입장이 막힌다', () => {
    const now = clock();
    const guard = createWrongCodeGuard({ limit: 2, windowMs: 60_000, blockMs: 5000, now });
    guard.fail('ip');
    guard.fail('ip');
    expect(guard.blocked('ip')).toBe(false);
    guard.fail('ip');
    expect(guard.blocked('ip')).toBe(true);
    expect(guard.blocked('other')).toBe(false);
    now.advance(5000);
    expect(guard.blocked('ip')).toBe(false);
  });

  // Defaults of config.js: 60 wrong codes a minute, +3 per successful join, 30 s block.
  const schoolGuard = (now) => createWrongCodeGuard({ limit: 60, bonusPerJoin: 3, windowMs: 60_000, blockMs: 30_000, now });

  it('학교 NAT 정상 수업 패턴(성공 30 + 오타 70, 섞여 들어옴)은 막히지 않는다', () => {
    const now = clock();
    const guard = schoolGuard(now);
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 7; i++) {
        guard.fail('school');
        expect(guard.blocked('school'), `round ${round}`).toBe(false);
      }
      for (let i = 0; i < 3; i++) guard.succeed('school');
      now.advance(1000);
    }
  });

  it('추측 패턴(성공 0 + 오타 61)은 막히고 30초 뒤 풀린다', () => {
    const now = clock();
    const guard = schoolGuard(now);
    for (let i = 0; i < 60; i++) guard.fail('guess');
    expect(guard.blocked('guess')).toBe(false);
    guard.fail('guess');
    expect(guard.blocked('guess')).toBe(true);
    now.advance(29_999);
    expect(guard.blocked('guess')).toBe(true);
    now.advance(1);
    expect(guard.blocked('guess')).toBe(false);
  });

  it('성공 입장은 같은 1분 창에서만 한도를 늘린다', () => {
    const now = clock();
    const guard = schoolGuard(now);
    for (let i = 0; i < 10; i++) guard.succeed('ip');
    now.advance(60_000);
    for (let i = 0; i < 61; i++) guard.fail('ip');
    expect(guard.blocked('ip')).toBe(true);
  });

  it('연결 수: 주소별·전체 상한', () => {
    const counter = createConnectionCounter({ maxTotal: 3, maxPerKey: 2 });
    expect([counter.tryOpen('a'), counter.tryOpen('a'), counter.tryOpen('a')]).toEqual([true, true, false]);
    expect([counter.tryOpen('b'), counter.tryOpen('c')]).toEqual([true, false]);
    counter.close('a');
    expect(counter.tryOpen('c')).toBe(true);
    expect(counter.total).toBe(3);
  });
});

describe('config', () => {
  const base = {
    SUPABASE_URL: 'http://127.0.0.1:1',
    SUPABASE_SERVICE_ROLE_KEY: 'service-secret-value',
    SESSION_SECRET: SECRET,
    ALLOWED_ORIGINS: 'https://jigsaw.gyosil.app, http://localhost:4173',
  };

  it('빠진 환경변수는 이름만 알리고 값은 말하지 않는다', () => {
    expect(() => readConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: '' })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => readConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/32/);
    try {
      readConfig({ ...base, SESSION_SECRET: 'short' });
    } catch (error) {
      expect(error.message).not.toContain('service-secret-value');
    }
  });

  it('시험 훅은 운영(NODE_ENV=production)에서는 켜지지 않는다', () => {
    expect(readConfig({ ...base, RT_TEST_HOOKS: '1', NODE_ENV: 'production' }).testHooks).toBe(false);
    expect(readConfig({ ...base, RT_TEST_HOOKS: '1' }).testHooks).toBe(true);
    expect(readConfig(base).testHooks).toBe(false);
    expect(readConfig(base).allowedOrigins).toEqual(['https://jigsaw.gyosil.app', 'http://localhost:4173']);
    expect(readConfig(base).limits).toMatchObject({ wrongCodes: 60, wrongCodeBonusPerJoin: 3, wrongCodeBlockMs: 30_000 });
  });
});

describe('client address through /rt', () => {
  const base = { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'k', SESSION_SECRET: SECRET, ALLOWED_ORIGINS: 'https://jigsaw.gyosil.app' };
  const secret = 'p'.repeat(48);
  const req = (headers) => ({ headers, socket: { remoteAddress: '76.76.21.9' } });
  const proxied = { 'x-jigsaw-proxy': secret, 'x-jigsaw-client': '203.0.113.9', 'x-forwarded-for': '76.76.21.9' };

  it('비밀값이 맞을 때만 /rt 가 넘긴 주소를 믿는다', () => {
    expect(proxiedAddress(req(proxied), secret)).toBe('203.0.113.9');
    expect(proxiedAddress(req({ ...proxied, 'x-jigsaw-proxy': 'q'.repeat(48) }), secret)).toBeNull();
    expect(proxiedAddress(req({ ...proxied, 'x-jigsaw-proxy': 'short' }), secret)).toBeNull();
    expect(proxiedAddress(req({ 'x-jigsaw-client': '203.0.113.9' }), secret)).toBeNull();
    expect(proxiedAddress(req({ ...proxied, 'x-jigsaw-client': '' }), secret)).toBeNull();
    expect(proxiedAddress(req(proxied), null)).toBeNull();
    // Without it the address is the one it always was.
    expect(clientAddress(req(proxied), true)).toBe('76.76.21.9');
  });

  it('RT_PROXY_SECRET 은 없어도 되고, 있으면 32바이트 이상이어야 하며 값은 말하지 않는다', () => {
    expect(readConfig(base).proxySecret).toBeNull();
    expect(readConfig({ ...base, RT_PROXY_SECRET: secret }).proxySecret).toBe(secret);
    const short = 'short-proxy-secret';
    expect(() => readConfig({ ...base, RT_PROXY_SECRET: short })).toThrow(/RT_PROXY_SECRET.*32바이트/);
    try {
      readConfig({ ...base, RT_PROXY_SECRET: short });
    } catch (error) {
      expect(error.message).not.toContain(short);
    }
  });
});

describe('start ticket (T20)', () => {
  it('시작하기 표는 교사 토큰으로 쓸 수 없고, 교사 토큰도 시작하기 표가 아니다', async () => {
    const { signStartTicket, verifyStartTicket } = await import('../../server/src/teacher-token.js');
    const ticket = signStartTicket('u1', SECRET);
    expect(verifyStartTicket(ticket, SECRET)).toBe('u1');
    expect(verifyTeacherToken(ticket, SECRET)).toBeNull();
    expect(verifyStartTicket(signTeacherToken('u1', SECRET), SECRET)).toBeNull();
  });
});
