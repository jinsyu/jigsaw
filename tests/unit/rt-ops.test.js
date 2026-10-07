import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// T24: the files scripts/rt/setup.sh installs on the rt server (spec D16, D17; plan memo
// 'Address and proxy'). Syntax is checked with shellcheck, systemd-analyze and caddy validate
// (docs/ops.md); this test pins the settings that matter for security and recovery.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const lines = (text) => text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));

const SERVER_KEYS = [
  'NODE_ENV',
  'HOST',
  'PORT',
  'RT_TRUST_PROXY',
  'ALLOWED_ORIGINS',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'SESSION_SECRET',
  'GOOGLE_CLIENT_ID',
];

describe('server/.env.example', () => {
  const entries = lines(read('server/.env.example')).map((l) => l.split('='));

  it('names every setting the server reads in production, each once, with no value', () => {
    expect(entries.map(([key]) => key)).toEqual(SERVER_KEYS);
    for (const [key, ...value] of entries) expect(value.join('='), key).toBe('');
  });

  it('covers the variables config.js requires', () => {
    const required = read('server/src/config.js').match(/const REQUIRED = \[([^\]]+)\]/)[1];
    for (const key of required.match(/'([A-Z_]+)'/g).map((k) => k.slice(1, -1))) expect(SERVER_KEYS).toContain(key);
  });
});

describe('scripts/rt/setup.sh env template', () => {
  const setup = read('scripts/rt/setup.sh');

  it('fills only non-secret production values: NODE_ENV=production, local address, Caddy proxy, the site origin', () => {
    const defaults = Object.fromEntries([...setup.matchAll(/^\s*set_default (\w+) '([^']*)'$/gm)].map((m) => [m[1], m[2]]));
    expect(defaults).toEqual({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '3400',
      RT_TRUST_PROXY: '1',
      ALLOWED_ORIGINS: 'https://jigsaw.gyosil.app',
      SUPABASE_URL: 'https://ozfzpyumnaaggrlevygz.supabase.co',
    });
  });

  it('creates the secrets file readable by root only', () => {
    expect(setup).toContain('ENV_FILE=/etc/jigsaw-rt.env');
    expect(setup).toMatch(/chmod 600 "\$ENV_FILE"/);
    expect(setup).toMatch(/chown root:root "\$ENV_FILE"/);
  });
});

describe('scripts/rt/jigsaw-rt.service', () => {
  const unit = read('scripts/rt/jigsaw-rt.service');
  const setting = (key) => lines(unit).filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));

  it('runs server/ as the dedicated user with the secrets file and production mode', () => {
    expect(setting('User')).toEqual(['jigsaw-rt']);
    expect(setting('EnvironmentFile')).toEqual(['/etc/jigsaw-rt.env']);
    expect(setting('Environment')).toContain('NODE_ENV=production');
    // The env file overrides Environment=, so the test hooks are removed at the very end.
    expect(setting('UnsetEnvironment')).toEqual(['RT_TEST_HOOKS']);
    expect(setting('ExecStart')).toEqual(['/usr/bin/node /opt/jigsaw/server/src/index.js']);
    expect(setting('Environment').some((e) => /^NODE_OPTIONS=--max-old-space-size=\d+$/.test(e))).toBe(true);
  });

  it('restarts on any exit and gives SIGTERM time to finish saving (D17)', () => {
    expect(setting('Restart')).toEqual(['always']);
    expect(setting('KillSignal')).toEqual(['SIGTERM']);
    expect(Number(setting('TimeoutStopSec')[0])).toBeGreaterThanOrEqual(30);
  });
});

describe('scripts/rt/Caddyfile', () => {
  const caddy = read('scripts/rt/Caddyfile');
  const directives = lines(caddy).join('\n');

  it('proxies rt.gyosil.app to the local server only', () => {
    expect(directives).toMatch(/^rt\.gyosil\.app \{$/m);
    expect(directives).toMatch(/^\s*reverse_proxy 127\.0\.0\.1:3400$/m);
  });

  it('keeps no access log in the site block and trusts no proxy, so X-Forwarded-For is the real client address', () => {
    const site = directives.slice(directives.indexOf('rt.gyosil.app {'));
    expect(site).not.toMatch(/\blog\b/);
    expect(directives).not.toMatch(/trusted_proxies/);
  });

  it('drops the client address, port and headers from the default (error) log', () => {
    const global = directives.slice(0, directives.indexOf('rt.gyosil.app {'));
    expect(global).toMatch(/^\{\n\tlog \{\n\t\tformat filter \{/);
    for (const field of ['request>remote_ip', 'request>client_ip', 'request>remote_port', 'request>headers']) {
      expect(global).toMatch(new RegExp(`^\\t+${field} delete$`, 'm'));
    }
  });
});

describe('journald and backup settings', () => {
  it('keeps the system journal for 14 days and no syslog copy (spec data table: server logs 14 days)', () => {
    const conf = lines(read('scripts/rt/journald-jigsaw.conf'));
    expect(conf).toContain('MaxRetentionSec=14day');
    expect(conf).toContain('MaxFileSec=1day');
    expect(conf).toContain('ForwardToSyslog=no');
  });

  it('installs the journald drop-in under a name applied after Ubuntu\'s syslog.conf (ForwardToSyslog=yes)', () => {
    const name = read('scripts/rt/setup.sh').match(/\/etc\/systemd\/journald\.conf\.d\/([\w.-]+\.conf)/)[1];
    expect([name, 'syslog.conf'].sort()).toEqual(['syslog.conf', name]);
  });

  it('dumps only the jigsaw schema, files readable by the owner only', () => {
    const backup = read('scripts/db/backup.sh');
    expect(backup).toContain('--schema=jigsaw');
    expect(backup).toMatch(/^umask 077$/m);
    expect(read('scripts/rt/jigsaw-backup.timer')).toMatch(/^OnCalendar=/m);
  });
});
