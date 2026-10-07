// Settings from the environment (/etc/jigsaw-rt.env in production, scripts/rt-dev.mjs locally).
// Errors name the missing variables, never their values.

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SESSION_SECRET', 'ALLOWED_ORIGINS'];

const int = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export function readConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0) throw new Error(`환경변수가 비어 있습니다: ${missing.join(', ')}`);
  if (env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET 은 32자 이상이어야 합니다.');
  const production = env.NODE_ENV === 'production';
  return {
    production,
    port: int(env.PORT, 3400),
    host: env.HOST || '127.0.0.1',
    supabaseUrl: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    // Used from T20 (teacher sign-in).
    anonKey: env.SUPABASE_ANON_KEY ?? '',
    googleClientId: env.GOOGLE_CLIENT_ID ?? '',
    sessionSecret: env.SESSION_SECRET,
    allowedOrigins: env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    // Local only: clock hooks and session creation for tests. Never in production.
    testHooks: !production && env.RT_TEST_HOOKS === '1',
    // Behind Caddy the client address is in X-Forwarded-For.
    trustProxy: env.RT_TRUST_PROXY === '1',
    limits: {
      maxConnections: int(env.RT_MAX_CONNECTIONS, 3000),
      // A whole school can share one public address (NAT), so this is generous.
      maxConnectionsPerIp: int(env.RT_MAX_CONNECTIONS_PER_IP, 200),
      messagesPerSecond: int(env.RT_MESSAGES_PER_SECOND, 30),
      httpPerMinute: int(env.RT_HTTP_PER_MINUTE, 1200),
      // Wrong codes per address per minute before a short block; each successful join in the
      // same minute adds RT_WRONG_CODE_BONUS (a class starting behind one NAT address).
      wrongCodes: int(env.RT_WRONG_CODE_LIMIT, 60),
      wrongCodeBonusPerJoin: int(env.RT_WRONG_CODE_BONUS, 3),
      wrongCodeWindowMs: int(env.RT_WRONG_CODE_WINDOW_MS, 60_000),
      wrongCodeBlockMs: int(env.RT_WRONG_CODE_BLOCK_MS, 30_000),
      maxOpenSessions: int(env.RT_MAX_OPEN_SESSIONS, 100),
      maxMembers: int(env.RT_MAX_MEMBERS, 60),
      bodyBytes: 4096,
      socketBytes: 16 * 1024,
    },
  };
}
