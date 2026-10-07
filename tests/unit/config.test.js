import { describe, expect, it } from 'vitest';
import { isConfigured, pickConfig } from '../../public/js/config.js';

describe('pickConfig', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('%s uses the local Supabase stack', (host) => {
    const config = pickConfig(host);
    expect(config.env).toBe('local');
    expect(config.supabaseUrl).toBe('http://127.0.0.1:56321');
    expect(config.publishableKey).toMatch(/^sb_publishable_/);
    expect(isConfigured(config)).toBe(true);
  });

  it.each(['192.168.0.12', '10.1.2.3', '172.20.0.5', 'my-mac.local'])(
    '%s (same Wi-Fi as a test tablet) reaches the local stack on that host',
    (host) => {
      const config = pickConfig(host);
      expect(config.env).toBe('local');
      expect(config.supabaseUrl).toBe(`http://${host}:56321`);
    },
  );

  it('any other host uses the shared gyosil project with its publishable key', () => {
    const config = pickConfig('jigsaw.gyosil.app');
    expect(config.env).toBe('remote');
    expect(config.supabaseUrl).toBe('https://ozfzpyumnaaggrlevygz.supabase.co');
    expect(config.publishableKey).toMatch(/^sb_publishable_/);
    expect(config.googleSignIn).toBe(true);
    expect(isConfigured(config)).toBe(true);
  });

  it('never ships a secret or service key', () => {
    for (const host of ['localhost', 'jigsaw.gyosil.app']) {
      const json = JSON.stringify(pickConfig(host));
      expect(json).not.toMatch(/service_role|sb_secret_/);
    }
  });

  it('the local stack has no Google sign-in and carries no account details', () => {
    const local = pickConfig('localhost');
    expect(local.googleSignIn).toBe(false);
    expect(Object.keys(local).sort()).toEqual(['env', 'googleSignIn', 'publishableKey', 'supabaseUrl']);
  });
});
