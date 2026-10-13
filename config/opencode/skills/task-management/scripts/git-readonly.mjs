// Pipeline git reads (status, diff, ls-files, rev-parse) must not take .git/index.lock: a worker,
// a parallel lane or publish may be writing the index at the same time. GIT_OPTIONAL_LOCKS only
// drops optional locks, so commands that do write still lock as usual.
export const gitReadEnv = (env = process.env) => ({ ...env, GIT_OPTIONAL_LOCKS: '0' });
