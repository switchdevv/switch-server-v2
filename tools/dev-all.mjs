// `pnpm dev:all`: the whole Switch platform in local dev, in one terminal.
//
//   Docker (Mongo + S3) → switch-server-v2 on :1337 → seed (once) → every client, pointed at
//   the local server through its own `:local` script. Nothing here can reach production.
//
//   pnpm dev:all                    everything
//   pnpm dev:all --only ops,food    the server plus the named clients
//   pnpm dev:all --skip mobile      no Metro bundlers (also: --skip web, or single names)
//
// Ctrl-C stops every process. Docker keeps running, so the next start is quick and the data is
// kept (`pnpm stack:down` stops it, `pnpm db:reset` re-seeds).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = dirname(serverDir);

/** Every client, its local-dev script and the port it takes. */
const CLIENTS = [
  {
    name: 'finance',
    group: 'web',
    dir: 'switch-finance',
    script: 'dev:local',
    port: 3000,
    url: 'http://localhost:3000',
  },
  {
    name: 'dashboard',
    group: 'web',
    dir: 'switch-dashboard',
    script: 'dev:local',
    port: 3010,
    url: 'http://localhost:3010',
  },
  {
    name: 'ops',
    group: 'web',
    dir: 'switch-ops',
    script: 'dev:local',
    port: 3020,
    url: 'http://localhost:3020',
  },
  { name: 'food', group: 'mobile', dir: 'switch-food', script: 'start:local', port: 8081 },
  { name: 'driver', group: 'mobile', dir: 'switch-driver', script: 'start:local', port: 8082 },
  { name: 'manager', group: 'mobile', dir: 'switch-manager', script: 'start:local', port: 8083 },
];
const SERVER_PORT = 1337;

// ---- options -------------------------------------------------------------------------------
const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? [] : (process.argv[i + 1] ?? '').split(',').filter(Boolean);
};
const only = argValue('--only');
const skip = argValue('--skip');
const matches = (client, names) => names.includes(client.name) || names.includes(client.group);
const selected = CLIENTS.filter(
  (c) => (only.length === 0 || matches(c, only)) && !matches(c, skip),
);

// ---- output --------------------------------------------------------------------------------
const tty = process.stdout.isTTY;
const COLORS = [36, 35, 33, 32, 34, 31, 96];
const width = Math.max('server'.length, ...CLIENTS.map((c) => c.name.length));
const tag = (name, i) => {
  const label = `[${name}]`.padEnd(width + 2);
  return tty ? `\x1b[${COLORS[i % COLORS.length]}m${label}\x1b[0m` : label;
};
const say = (text) =>
  process.stdout.write(`${tty ? '\x1b[1m' : ''}${text}${tty ? '\x1b[0m' : ''}\n`);

/** The server logs pino JSON; show it as `LEVEL message {fields}`. */
function pretty(line) {
  if (!line.startsWith('{')) return line;
  try {
    const {
      severity,
      level,
      msg,
      time: _time,
      pid: _pid,
      hostname: _host,
      ...rest
    } = JSON.parse(line);
    const fields = Object.keys(rest).length > 0 ? ' ' + JSON.stringify(rest) : '';
    return `${severity ?? level ?? ''} ${msg ?? ''}${fields}`.trim();
  } catch {
    return line;
  }
}

function pipe(stream, prefix, format = (l) => l) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) process.stdout.write(`${prefix} ${format(line)}\n`);
  });
}

// ---- processes -----------------------------------------------------------------------------
const children = [];
let stopping = false;

function start(name, index, cwd, command, args, format) {
  const child = spawn(command, args, {
    cwd,
    detached: true, // own process group, so Ctrl-C can stop the whole tree
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: tty ? '1' : '0' },
  });
  const prefix = tag(name, index);
  pipe(child.stdout, prefix, format);
  pipe(child.stderr, prefix, format);
  child.on('exit', (code, signal) => {
    if (!stopping) process.stdout.write(`${prefix} exited (${signal ?? `code ${code}`})\n`);
  });
  children.push(child);
  return child;
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  say('\nStopping…');
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    for (const child of children) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    process.exit(0);
  }, 5000).unref();
  Promise.all(
    children.map((c) => new Promise((r) => (c.exitCode === null ? c.on('exit', r) : r()))),
  ).then(() => process.exit(0));
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

const portFree = (port) =>
  new Promise((resolveFree) => {
    const probe = createServer()
      .once('error', () => resolveFree(false))
      .once('listening', () => probe.close(() => resolveFree(true)))
      .listen(port);
  });

function fail(message) {
  say(`\n✖ ${message}`);
  process.exit(1);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) fail(`\`${command} ${args.join(' ')}\` failed (in ${cwd}).`);
}

// ---- pre-flight ----------------------------------------------------------------------------
const missing = selected.filter((c) => !existsSync(join(workspace, c.dir, 'node_modules')));
if (missing.length > 0) {
  fail(
    `Install dependencies first: ${missing.map((c) => `(cd ${c.dir} && npm install)`).join(', ')}`,
  );
}
for (const { name, port } of [{ name: 'server', port: SERVER_PORT }, ...selected]) {
  if (!(await portFree(port)))
    fail(`Port ${port} (${name}) is taken. Stop whatever runs there: lsof -i :${port}`);
}
if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  fail('Docker is not running. Start Docker Desktop, then run this again.');
}
if (!existsSync(join(serverDir, '.env.local'))) run('node', ['tools/setup-env.mjs'], serverDir);

// ---- start ---------------------------------------------------------------------------------
say('▶ Docker: Mongo (27018) and SeaweedFS S3 (9000)');
run('pnpm', ['-s', 'stack:up'], serverDir);

say(`▶ switch-server-v2 on http://localhost:${SERVER_PORT}`);
start('server', 0, serverDir, 'pnpm', ['-s', 'dev'], pretty);
const deadline = Date.now() + 90_000;
for (;;) {
  const up = await fetch(`http://localhost:${SERVER_PORT}/health`).then(
    (res) => res.ok,
    () => false,
  );
  if (up) break;
  if (Date.now() > deadline || children[0].exitCode !== null) {
    stopAll();
    fail('The server did not come up; see its log above.');
  }
  await new Promise((r) => setTimeout(r, 500));
}

say('▶ Seed (skipped when the database already has data)');
run('pnpm', ['-s', 'seed'], serverDir);

selected.forEach((client, i) => {
  start(client.name, i + 1, join(workspace, client.dir), 'npm', ['run', '--silent', client.script]);
});

const web = selected.filter((c) => c.group === 'web');
const mobile = selected.filter((c) => c.group === 'mobile');
say(
  [
    '',
    '━━ Switch local dev ━━ (Ctrl-C stops everything; Docker keeps running)',
    `  server     http://localhost:${SERVER_PORT}   (fake push/SMS/email: shown in its log)`,
    ...web.map((c) => `  ${c.name.padEnd(10)} ${c.url}`),
    ...mobile.map((c) => `  ${c.name.padEnd(10)} Metro on :${c.port}`),
    ...(mobile.length > 0
      ? [
          '',
          '  Install a phone app once Metro is up (other terminal, from its folder):',
          ...mobile.map((c) => `    cd ${c.dir} && npm run android:local   # or ios:local`),
        ]
      : []),
    '',
  ].join('\n'),
);
