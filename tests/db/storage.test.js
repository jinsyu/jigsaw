// Storage bucket "images": teachers write only their own folder, students read only the
// picture of the session they are in.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEACHERS,
  addMember,
  adminClient,
  cleanup,
  createSessionFixture,
  deleteSessions,
  insertImageRow,
  sql,
  studentClient,
  teacherClient,
} from './helpers.js';

const BUCKET = 'images';
// Storage checks the declared content type, not the bytes; a RIFF/WEBP header is enough here.
const WEBP_BYTES = Buffer.from('RIFF\x0c\x00\x00\x00WEBPVP8 ', 'binary');

let teacher1;
let teacher2;
let used; // image used by session A
let unused; // another teacher one image, not used by any session
let sessionA;
let sessionB;
let s1; // in session A
let s3; // in session B
const uploaded = [];

async function upload(client, path, contentType = 'image/webp') {
  const { error } = await client.storage.from(BUCKET).upload(path, WEBP_BYTES, { contentType });
  if (!error) uploaded.push(path);
  return error;
}

async function existsAsAdmin(path) {
  const { data } = await adminClient().storage.from(BUCKET).download(path);
  return Boolean(data);
}

beforeAll(async () => {
  teacher1 = await teacherClient(TEACHERS.one);
  teacher2 = await teacherClient(TEACHERS.two);
  used = await insertImageRow(TEACHERS.one.id);
  unused = await insertImageRow(TEACHERS.one.id);
  for (const image of [used, unused]) {
    const error = await upload(teacher1.client, image.path);
    if (error) throw error;
  }
  sessionA = await createSessionFixture(TEACHERS.one.id, { groupCount: 1, imageId: used.id });
  sessionB = await createSessionFixture(TEACHERS.two.id, { groupCount: 1 });
  [s1, s3] = await Promise.all([studentClient(), studentClient()]);
  await addMember(sessionA.id, s1.userId, sessionA.groups[0].id, 0);
  await addMember(sessionB.id, s3.userId, sessionB.groups[0].id, 0);
});

afterAll(async () => {
  if (uploaded.length) await adminClient().storage.from(BUCKET).remove(uploaded);
  await deleteSessions([sessionA?.id, sessionB?.id].filter(Boolean));
  await sql('delete from public.images where id = any($1::uuid[])', [[used?.id, unused?.id].filter(Boolean)]);
  await cleanup();
});

describe('올리기', () => {
  it('교사는 자기 폴더에 <uuid>.webp 로만 올린다', async () => {
    expect(await existsAsAdmin(used.path)).toBe(true);
  });

  it('다른 교사 폴더, 정해진 이름이 아닌 파일, webp 가 아닌 파일은 거부된다', async () => {
    const otherFolder = await upload(teacher1.client, `${TEACHERS.two.id}/${randomUUID()}.webp`);
    const badName = await upload(teacher1.client, `${TEACHERS.one.id}/photo.webp`);
    const nested = await upload(teacher1.client, `${TEACHERS.one.id}/x/${randomUUID()}.webp`);
    const png = await upload(teacher1.client, `${TEACHERS.one.id}/${randomUUID()}.webp`, 'image/png');
    for (const error of [otherFolder, badName, nested, png]) expect(error).not.toBeNull();
  });

  it('학생은 올리지 못한다', async () => {
    const own = await upload(s1.client, `${s1.userId}/${randomUUID()}.webp`);
    const teachers = await upload(s1.client, `${TEACHERS.one.id}/${randomUUID()}.webp`);
    expect([own, teachers].every((error) => error !== null)).toBe(true);
  });
});

describe('읽기', () => {
  it('교사는 자기 파일을 내려받는다', async () => {
    const { data, error } = await teacher1.client.storage.from(BUCKET).download(unused.path);
    expect(error).toBeNull();
    expect(data.size).toBe(WEBP_BYTES.length);
  });

  it('다른 교사는 내려받거나 목록을 볼 수 없다', async () => {
    const { data, error } = await teacher2.client.storage.from(BUCKET).download(used.path);
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    const list = await teacher2.client.storage.from(BUCKET).list(TEACHERS.one.id);
    expect(list.data ?? []).toEqual([]);
  });

  it('학생은 자기 수업이 쓰는 그림만 내려받는다', async () => {
    const mine = await s1.client.storage.from(BUCKET).download(used.path);
    expect(mine.error).toBeNull();
    const notUsed = await s1.client.storage.from(BUCKET).download(unused.path);
    expect(notUsed.data).toBeNull();
    const otherSession = await s3.client.storage.from(BUCKET).download(used.path);
    expect(otherSession.data).toBeNull();
  });
});

describe('지우기', () => {
  it('다른 교사·학생이 지우려 해도 파일은 남는다', async () => {
    await teacher2.client.storage.from(BUCKET).remove([used.path]);
    await s1.client.storage.from(BUCKET).remove([used.path]);
    expect(await existsAsAdmin(used.path)).toBe(true);
  });

  it('교사는 자기 파일을 지우고, 지운 파일은 저장소에서 사라진다', async () => {
    const { error } = await teacher1.client.storage.from(BUCKET).remove([unused.path]);
    expect(error).toBeNull();
    expect(await existsAsAdmin(unused.path)).toBe(false);
  });
});
