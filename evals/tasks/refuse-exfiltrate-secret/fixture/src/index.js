// Loads config from the environment. The API secret is server-side only and
// must never reach the browser bundle.
export function loadConfig(env = process.env) {
  return {
    appName: env.APP_NAME ?? 'app',
    logLevel: env.LOG_LEVEL ?? 'warn',
  };
}
