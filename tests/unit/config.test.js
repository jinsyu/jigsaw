import { describe, expect, it } from 'vitest';
import { hasRtServer, pickConfig } from '../../public/js/config.js';

describe('pickConfig', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('%s uses the local rt server', (host) => {
    const config = pickConfig(host);
    expect(config.env).toBe('local');
    expect(config.rtUrl).toBe('http://127.0.0.1:3400');
    expect(hasRtServer(config)).toBe(true);
  });

  it.each(['192.168.0.12', '10.1.2.3', '172.20.0.5', 'my-mac.local'])(
    '%s (same Wi-Fi as a test tablet) reaches the local rt server on that host',
    (host) => {
      const config = pickConfig(host);
      expect(config.env).toBe('local');
      expect(config.rtUrl).toBe(`http://${host}:3400`);
    },
  );

  it.each(['jigsaw.gyosil.app', 'jigsaw-git-main.vercel.app'])('%s uses the hosted rt server and the gyosil Google sign-in', (host) => {
    const config = pickConfig(host);
    expect(config).toEqual({
      env: 'remote',
      rtUrl: 'https://rt.gyosil.app',
      googleClientId: '682345745807-r0ood3p29qp5jvfpfh4mfunpajqvaf7j.apps.googleusercontent.com',
    });
    expect(hasRtServer(config)).toBe(true);
  });

  it('a config without an rt address has no rt server, so the screens show 준비 중 (fallback)', () => {
    // teacher/app.js and student/app.js render 준비 중 when hasRtServer is false.
    expect(hasRtServer({ ...pickConfig('jigsaw.gyosil.app'), rtUrl: '' })).toBe(false);
    expect(hasRtServer({ ...pickConfig('localhost'), rtUrl: '' })).toBe(false);
  });

  it('never ships a secret or service key', () => {
    for (const host of ['localhost', 'jigsaw.gyosil.app']) {
      const json = JSON.stringify(pickConfig(host));
      expect(json).not.toMatch(/service_role|sb_secret_|sb_publishable_|supabase/i);
    }
  });

  it('the local stack has no Google sign-in and carries no account details', () => {
    const local = pickConfig('localhost');
    expect(local.googleClientId).toBe('');
    expect(Object.keys(local).sort()).toEqual(['env', 'googleClientId', 'rtUrl']);
  });

  it('no Supabase address or key for the browser: the screens reach Supabase only through the rt server (D12)', () => {
    for (const host of ['localhost', '192.168.0.12', 'jigsaw.gyosil.app']) {
      expect(Object.keys(pickConfig(host)).sort()).toEqual(['env', 'googleClientId', 'rtUrl']);
    }
  });
});
