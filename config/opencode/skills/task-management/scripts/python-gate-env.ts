import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import process from 'node:process';

export class PythonGateEnvironmentError extends Error {}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findUv(cwd: string): Promise<string> {
  const paths = [...(process.env.PATH ?? '').split(delimiter).map((directory) => resolve(directory || cwd, 'uv')),
    join(homedir(), '.local', 'bin', 'uv')];
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Try another PATH entry.
    }
  }
  throw new PythonGateEnvironmentError('uv is unavailable; update my-opencode distribution before running Python gates');
}

export function isPythonTestInvocation(executable: string, args: string[]): boolean {
  return executable === 'pytest' ||
    ((executable === 'python' || executable === 'python3') && args[0] === '-m' && args[1] === 'pytest');
}

export async function inspectPythonProject(cwd: string): Promise<{
  managed: boolean;
  uv?: string;
  pythonVersion?: string;
}> {
  const root = resolve(cwd);
  const lockPresent = await exists(join(root, 'uv.lock'));
  if (!lockPresent) return { managed: false }; // Preserve legacy non-uv Python projects.
  if (!await exists(join(root, 'pyproject.toml'))) {
    throw new PythonGateEnvironmentError('uv.lock exists without pyproject.toml');
  }
  const uv = await findUv(root);
  const version = await readFile(join(root, '.python-version'), 'utf8').catch(() => '');
  const pythonVersion = version.trim();
  if (pythonVersion && !/^3\.\d{1,2}(?:\.\d{1,2})?$/.test(pythonVersion)) {
    throw new PythonGateEnvironmentError('unsupported .python-version; expected an exact Python 3 version');
  }
  return { managed: true, uv, ...(pythonVersion ? { pythonVersion } : {}) };
}

function command(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((finish, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostic = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk: Buffer) => {
        if (diagnostic.length < 8192) diagnostic += String(chunk).slice(0, 8192 - diagnostic.length);
      });
    }
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? finish() : reject(new PythonGateEnvironmentError(
      `${executable} ${args.slice(0, 2).join(' ')} exited ${code}: ${diagnostic.trim()}`,
    )));
  });
}

export async function preparePythonTestEnvironment(cwd: string): Promise<{
  env: NodeJS.ProcessEnv;
  python: string;
  dependencySource: 'uv.lock';
} | undefined> {
  const root = resolve(cwd);
  const project = await inspectPythonProject(root);
  if (!project.managed || !project.uv) return undefined;
  const venv = join(root, '.venv');
  const venvStat = await lstat(venv).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (venvStat?.isSymbolicLink() || (venvStat && !venvStat.isDirectory())) {
    throw new PythonGateEnvironmentError('.venv must be a local directory; refusing to follow a symlink');
  }

  // Never change the frozen gate command or the system interpreter. uv owns only
  // the project-local, Git-ignored environment and shared user cache/interpreters.
  const lockPath = join(root, 'uv.lock');
  const lockBefore = await readFile(lockPath);
  const env: NodeJS.ProcessEnv = { ...process.env, UV_PROJECT_ENVIRONMENT: venv };
  const syncArgs = ['sync', '--frozen', ...(project.pythonVersion ? ['--python', project.pythonVersion] : [])];
  await command(project.uv, syncArgs, root, env);
  const lockAfter = await readFile(lockPath);
  if (!lockBefore.equals(lockAfter)) {
    throw new PythonGateEnvironmentError('uv sync changed uv.lock despite --frozen; refusing to execute gate');
  }
  const python = join(venv, 'bin', 'python');
  await access(python, constants.X_OK);
  await command(python, ['-m', 'pytest', '--version'], root, env);
  return {
    env: { ...env, VIRTUAL_ENV: venv, PATH: `${join(venv, 'bin')}${delimiter}${process.env.PATH ?? ''}` },
    python,
    dependencySource: 'uv.lock',
  };
}
