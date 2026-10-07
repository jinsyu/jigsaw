// Realtime private channel permissions (realtime.messages policies) and realtime.send delivery.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TEACHERS,
  addMember,
  cleanup,
  createSessionFixture,
  deleteSessions,
  leaveAllChannels,
  sleep,
  sql,
  studentClient,
  subscribe,
  teacherClient,
  waitFor,
} from './helpers.js';

let sessionA;
let sessionB;
let a1;
let a2;
let s1; // A1
let s5; // A1
let s2; // A2
let s3; // session B
let teacher1;
let teacher2;

// Refused joins come back as CHANNEL_ERROR with Realtime's "do not have permissions" reason.
function expectRefused(...results) {
  for (const { status, error } of results) {
    expect(status).toBe('CHANNEL_ERROR');
    expect(error?.message).toMatch(/permission/i);
  }
}

async function send(topic, event, payload) {
  await sql('select realtime.send($1::jsonb, $2, $3, true)', [JSON.stringify(payload), event, topic]);
}

beforeAll(async () => {
  sessionA = await createSessionFixture(TEACHERS.one.id, { groupCount: 2 });
  sessionB = await createSessionFixture(TEACHERS.two.id, { groupCount: 1 });
  [a1, a2] = sessionA.groups;
  [s1, s5, s2, s3] = await Promise.all([1, 2, 3, 4].map(() => studentClient()));
  await addMember(sessionA.id, s1.userId, a1.id, 0);
  await addMember(sessionA.id, s5.userId, a1.id, 1);
  await addMember(sessionA.id, s2.userId, a2.id, 0);
  await addMember(sessionB.id, s3.userId, sessionB.groups[0].id, 0);
  teacher1 = await teacherClient(TEACHERS.one);
  teacher2 = await teacherClient(TEACHERS.two);
});

afterEach(leaveAllChannels);

afterAll(async () => {
  await deleteSessions([sessionA?.id, sessionB?.id].filter(Boolean));
  await cleanup();
});

describe('jigsaw:group:<id> 채널', () => {
  it('그 모둠 학생과 담당 교사는 구독하고 realtime.send 방송을 받는다', async () => {
    const topic = `jigsaw:group:${a1.id}`;
    const student = await subscribe(s1.client, topic);
    const teacher = await subscribe(teacher1.client, topic);
    expect([student.status, teacher.status]).toEqual(['SUBSCRIBED', 'SUBSCRIBED']);

    // Right after the stack starts, Realtime opens its database stream lazily on the first
    // private join, so the very first messages can be missed. Repeat until one arrives.
    let delivered = false;
    for (let attempt = 0; attempt < 10 && !delivered; attempt += 1) {
      await send(topic, 'drop', { cluster: 1, x: 0.1 + 0.2 });
      delivered = await waitFor(
        () => student.received.length > 0 && teacher.received.length > 0,
        { timeout: 1000 },
      );
    }
    expect(delivered).toBe(true);
    expect(student.received[0]).toMatchObject({ event: 'drop', payload: { cluster: 1, x: 0.1 + 0.2 } });
  });

  it('다른 모둠 학생의 구독은 거부된다', async () => {
    expectRefused(await subscribe(s2.client, `jigsaw:group:${a1.id}`));
  });

  it('jigsaw: 접두가 없는 토픽(공용 프로젝트의 다른 이름)은 그 모둠 학생도 구독할 수 없다', async () => {
    const refused = await Promise.all([
      subscribe(s1.client, `group:${a1.id}`),
      subscribe(s5.client, `other:jigsaw:group:${a1.id}`),
    ]);
    expectRefused(...refused);
  });

  it('다른 수업 학생·다른 교사의 구독은 거부된다', async () => {
    // Realtime answers a refused join after about 5 seconds, so try both at once.
    const refused = await Promise.all([
      subscribe(s3.client, `jigsaw:group:${a1.id}`),
      subscribe(teacher2.client, `jigsaw:group:${a1.id}`),
    ]);
    expectRefused(...refused);
  });

  it('같은 이름의 공개 채널로는 비공개 방송을 받지 못한다', async () => {
    const topic = `jigsaw:group:${a1.id}`;
    const eavesdrop = await subscribe(s3.client, topic, { isPrivate: false });
    const member = await subscribe(s5.client, topic);
    expect(member.status).toBe('SUBSCRIBED');
    await send(topic, 'grab', { cluster: 2 });
    expect(await waitFor(() => member.received.length > 0)).toBe(true);
    await sleep(500);
    expect(eavesdrop.received).toEqual([]);
  });

  it('학생이 모둠 채널에 직접 보낸 방송은 아무도 받지 못한다 (방송은 RPC 만)', async () => {
    const topic = `jigsaw:group:${a1.id}`;
    const listener = await subscribe(teacher1.client, topic);
    const sender = await subscribe(s1.client, topic);
    expect([listener.status, sender.status]).toEqual(['SUBSCRIBED', 'SUBSCRIBED']);
    await sender.channel.send({ type: 'broadcast', event: 'drop', payload: { forged: true } });
    await sleep(1500);
    expect(listener.received.filter((m) => m.payload?.forged)).toEqual([]);
  });
});

describe('jigsaw:session:<id> 채널 (Presence)', () => {
  it('수업 참가자와 교사는 구독하고, 교사는 학생 Presence 를 본다', async () => {
    const topic = `jigsaw:session:${sessionA.id}`;
    const teacher = await subscribe(teacher1.client, topic, { presenceKey: teacher1.userId });
    const student = await subscribe(s2.client, topic, { presenceKey: s2.userId });
    expect([teacher.status, student.status]).toEqual(['SUBSCRIBED', 'SUBSCRIBED']);

    const tracked = await student.channel.track({ color: 0 });
    expect(tracked).toBe('ok');
    const seen = await waitFor(() => Object.keys(teacher.channel.presenceState()).includes(s2.userId));
    expect(seen).toBe(true);
  });

  it('다른 수업 학생·다른 교사의 구독은 거부된다', async () => {
    const topic = `jigsaw:session:${sessionA.id}`;
    const refused = await Promise.all([
      subscribe(s3.client, topic, { presenceKey: s3.userId }),
      subscribe(teacher2.client, topic, { presenceKey: teacher2.userId }),
    ]);
    expectRefused(...refused);
  });

  it('정해진 이름이 아닌 비공개 채널은 거부된다', async () => {
    expectRefused(await subscribe(s1.client, `lobby:${sessionA.id}`));
  });
});
