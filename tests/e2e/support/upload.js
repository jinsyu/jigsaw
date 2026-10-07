// Helpers for the upload E2E tests (T8, T21): the test photo, pictures created through the rt
// server (private bucket jigsaw-images, table jigsaw.images), checks of the stored file.
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { cleanUpClasses, closeSql, deleteImages, sql } from './teacher.js';
import { storageAdmin, webpChunks, webpSize } from './storage.js';

export const PHOTO = fileURLToPath(new URL('../../fixtures/exif-photo.jpg', import.meta.url)); // 2400 x 1600, EXIF orientation 6, GPS
export const createdImages = new Set();

export async function cleanUpUploads() {
  await cleanUpClasses();
  await deleteImages([...createdImages], storageAdmin().storage);
  createdImages.clear();
  await closeSql();
}

// The picture just uploaded through `uploader` (its data-uploaded-id), tracked for cleanup.
export async function uploadedImage(uploader) {
  await expect(uploader).toHaveAttribute('data-uploaded-id', /^[0-9a-f-]{36}$/, { timeout: 30_000 });
  const id = await uploader.getAttribute('data-uploaded-id');
  createdImages.add(id);
  const { rows } = await sql('select id, teacher_id, path, width, height from jigsaw.images where id = $1', [id]);
  return rows[0];
}

export async function storedFile(path) {
  const { data, error } = await storageAdmin().storage.from('jigsaw-images').download(path);
  if (error) return null;
  return Buffer.from(await data.arrayBuffer());
}

export async function expectCleanWebp(image) {
  expect(image.width).toBe(1333); // EXIF orientation applied: the photo is upright
  expect(image.height).toBe(2000);
  expect(image.path).toBe(`${image.teacher_id}/${image.id}.webp`);
  const bytes = await storedFile(image.path);
  expect(bytes.toString('latin1', 0, 4)).toBe('RIFF');
  expect(bytes.toString('latin1', 8, 12)).toBe('WEBP');
  expect(webpSize(bytes)).toEqual({ width: 1333, height: 2000 });
  expect(webpChunks(bytes).filter((c) => c === 'EXIF' || c === 'XMP ')).toEqual([]);
  const text = bytes.toString('latin1');
  for (const trace of ['JigsawTestCam', 'TestModel', 'Exif', '2026:10:07']) expect(text).not.toContain(trace);
}
