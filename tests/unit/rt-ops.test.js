import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// T24: the files scripts/rt/setup.sh installs on the rt server (spec D16, D17; plan memo
// 'Address and proxy'), since T25 follow-up laid out for several apps (docs/ops.md '새 앱 추가').
// Syntax is checked with shellcheck, systemd-analyze and caddy validate (docs/ops.md); this test
// pins the settings that matter for security and recovery.
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

describe('Caddy: shared Caddyfile and per-app site files', () => {
  const shared = lines(read('scripts/rt/caddy/Caddyfile')).join('\n');
  const site = lines(read('scripts/rt/caddy/sites/jigsaw.caddy')).join('\n');
  const template = lines(read('scripts/rt/caddy/sites/_template.caddy.example')).join('\n');

  it('keeps only global options in the shared Caddyfile and imports every app site file last', () => {
    expect(shared).toMatch(/^\{\n\tlog \{\n\t\tformat filter \{/);
    expect(shared.split('\n').at(-1)).toBe('import /etc/caddy/sites/*.caddy');
    // No site address at the top level: the only top-level lines are the global block and import.
    const topLevel = shared.split('\n').filter((l) => !/^\s/.test(l));
    expect(topLevel).toEqual(['{', '}', 'import /etc/caddy/sites/*.caddy']);
  });

  it('drops the client address, port and headers from the default (error) log', () => {
    for (const field of ['request>remote_ip', 'request>client_ip', 'request>remote_port', 'request>headers']) {
      expect(shared).toMatch(new RegExp(`^\\t+${field} delete$`, 'm'));
    }
  });

  // Other loggers of the default log: tls ("served key authentication certificate" during a
  // certificate check has `remote`: address:port) and admin.api (remote_ip, remote_port, headers).
  it('drops the client address from the tls and admin.api loggers too', () => {
    for (const field of ['remote', 'remote_ip', 'remote_port', 'headers']) {
      expect(shared).toMatch(new RegExp(`^\\t+${field} delete$`, 'm'));
    }
  });

  it('proxies rt.gyosil.app to the local jigsaw server only, on the port of the unit and env template', () => {
    expect(site).toMatch(/^rt\.gyosil\.app \{$/m);
    expect(site).toMatch(/^\s*reverse_proxy 127\.0\.0\.1:3400 \{$/m);
    expect(read('scripts/rt/jigsaw-rt.service')).toMatch(/^Environment=PORT=3400$/m);
    expect(read('scripts/rt/setup.sh')).toMatch(/^\s*set_default PORT '3400'$/m);
  });

  it('keeps no access log and trusts no proxy anywhere, so X-Forwarded-For is the real client address', () => {
    expect(shared).not.toMatch(/trusted_proxies/);
    for (const file of [site, template]) {
      expect(file).not.toMatch(/\blog\b/);
      expect(file).not.toMatch(/trusted_proxies/);
    }
  });

  it('gives other apps a template that Caddy never loads, proxying to a local port', () => {
    expect('_template.caddy.example').not.toMatch(/\.caddy$/);
    expect(template).toMatch(/^\s*reverse_proxy 127\.0\.0\.1:\d+ \{$/m);
  });

  // By default a Caddy reload closes every open WebSocket at once; adding another app's site file
  // reloads Caddy, so jigsaw classes would be cut. The delay keeps them open across a reload.
  it('keeps open WebSockets across a Caddy reload for 5 minutes (jigsaw and the template)', () => {
    for (const file of [site, template]) expect(file).toMatch(/^\t\tstream_close_delay 5m$/m);
  });
});

describe('scripts/rt/setup.sh Caddy steps', () => {
  const setup = read('scripts/rt/setup.sh');

  it('writes only its own site file in /etc/caddy/sites, never other apps\' files', () => {
    expect(setup).toContain('CADDY_SITES_DIR=/etc/caddy/sites');
    expect(setup).toContain('APP_SITE_FILE=$CADDY_SITES_DIR/jigsaw.caddy');
    const sitesWrites = setup
      .split('\n')
      .filter((l) => /CADDY_SITES_DIR/.test(l) && /\b(rm|mv|cp|install|sed|tee)\b|>/.test(l) && !/^\s*#/.test(l));
    for (const line of sitesWrites) expect(line).toMatch(/install -d -m 755 -o root -g root "\$CADDY_SITES_DIR"/);
  });

  it('checks the configuration before reload and reloads instead of restarting Caddy', () => {
    expect(setup).toMatch(/caddy validate --config "\$CADDYFILE" --adapter caddyfile/);
    expect(setup).toMatch(/systemctl reload caddy/);
    expect(setup).not.toMatch(/systemctl restart caddy/);
    const code = lines(setup).join('\n');
    expect(code.indexOf('caddy validate --config "$CADDYFILE"')).toBeLessThan(code.indexOf('systemctl reload caddy'));
  });

  it('replaces without asking only the earlier jigsaw-only Caddyfiles, listed by sha256', () => {
    const block = setup.match(/OLD_JIGSAW_CADDYFILES=\(([^)]*)\)/)[1];
    expect(block.trim().split(/\s+/)).toEqual([
      '86556c875afbec46b22213a4912978f4e02e687d4ec56885fbe72711d6e2c37d',
      '5be54175dba8b58cfe058b7aac90b5237804452921761d78b3c66edcdbf414ec',
    ]);
  });
});

describe('journald and backup settings', () => {
  it('keeps the system journal for 14 days and no syslog copy (spec data table: server logs 14 days)', () => {
    const conf = lines(read('scripts/rt/journald-retention.conf'));
    expect(conf).toContain('MaxRetentionSec=14day');
    expect(conf).toContain('MaxFileSec=1day');
    expect(conf).toContain('ForwardToSyslog=no');
  });

  it('installs the journald drop-in under an app-neutral name applied after Ubuntu\'s syslog.conf (ForwardToSyslog=yes)', () => {
    const setup = read('scripts/rt/setup.sh');
    expect(setup).toMatch(/^JOURNALD_DIR=\/etc\/systemd\/journald\.conf\.d$/m);
    const name = setup.match(/^JOURNALD_FILE=\$JOURNALD_DIR\/([\w.-]+\.conf)$/m)[1];
    expect(name).toBe('zz-retention.conf');
    expect([name, 'syslog.conf'].sort()).toEqual(['syslog.conf', name]);
    // The earlier name is moved aside so the same settings are not kept under two names.
    expect(setup).toMatch(/^OLD_JOURNALD_FILE=\$JOURNALD_DIR\/zz-jigsaw\.conf$/m);
  });

  it('dumps only the jigsaw schema, files readable by the owner only', () => {
    const backup = read('scripts/db/backup.sh');
    expect(backup).toContain('--schema=jigsaw');
    expect(backup).toMatch(/^umask 077$/m);
    expect(read('scripts/rt/jigsaw-backup.timer')).toMatch(/^OnCalendar=/m);
  });
});
