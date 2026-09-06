const ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'TERMINFO',
  'TMPDIR',
  'TMP',
  'TEMP',
  'PWD',
  'NODE_ENV',
  'COLORTERM',
  'TERM_PROGRAM',
  'TZ',
]);

const SECRET_KEY = /key|token|secret|password|passwd|credential/i;

export function isSecretEnvKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Copy a tight env allowlist, never passing API keys or tokens to child processes. */
export function sandboxedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined && !isSecretEnvKey(key)) out[key] = value;
  }
  return out;
}
