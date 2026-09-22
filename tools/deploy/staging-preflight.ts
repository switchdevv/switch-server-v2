// Deploy preflight for staging, run by .github/workflows/deploy-staging.yml before `gcloud app
// deploy` (and by you, to check a setup): the committed .env.staging must describe the project it
// is about to be deployed to. Otherwise the new version would only crash-loop on App Engine, with
// the reason buried in its logs. Read-only: it reads .env.staging and asks gcloud for the App
// Engine URL and the state of the pinned secret version, never for the secret itself.
//
//   node tools/deploy/staging-preflight.ts --project <staging GCP project id>
//
// Node runs this TypeScript file as is (type stripping), so it imports only node: modules.
// Outputs for the workflow (GITHUB_OUTPUT): url, app_id.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export interface StagingFacts {
  /** The GCP project the workflow deploys to. */
  project: string;
  /** That project's App Engine default hostname (`gcloud app describe`). */
  hostname: string;
  /** State of the pinned secret version (ENABLED, DISABLED, DESTROYED); undefined when missing. */
  secretState: string | undefined;
}

type EnvFile = Record<string, string | undefined>;

const secretName = (env: EnvFile) => env.SECRETS_NAME || 'switch-server-env';
const pinned = (version: string | undefined) => /^[1-9]\d*$/.test(version ?? '');

/** What stops this .env.staging from being deployed to that project. Empty means go. */
export function stagingProblems(env: EnvFile, facts: StagingFacts): string[] {
  const problems: string[] = [];
  const url = `https://${facts.hostname}`;
  if (env.SECRETS_SOURCE !== 'gcp') problems.push('SECRETS_SOURCE must be gcp');
  if (env.SECRETS_PROJECT !== facts.project) {
    problems.push(
      `SECRETS_PROJECT is "${env.SECRETS_PROJECT ?? ''}" but the deploy goes to ${facts.project}: ` +
        `set SECRETS_PROJECT=${facts.project}`,
    );
  }
  if (!pinned(env.SECRETS_VERSION)) {
    problems.push(
      'SECRETS_VERSION is not set: add the secret with `pnpm staging:secret`, then commit .env.staging',
    );
  } else if (facts.secretState !== 'ENABLED') {
    problems.push(
      `secret ${secretName(env)} version ${env.SECRETS_VERSION} is ` +
        `${facts.secretState?.toLowerCase() ?? 'missing'} in ${facts.project}`,
    );
  }
  // Parse is mounted at `/`, and email links are built from this URL.
  const publicUrl = env.PARSE_PUBLIC_SERVER_URL ?? '';
  if (!URL.canParse(publicUrl) || new URL(publicUrl).href !== `${url}/`) {
    problems.push(
      `PARSE_PUBLIC_SERVER_URL is "${publicUrl}": set PARSE_PUBLIC_SERVER_URL=${url} ` +
        '(the staging App Engine URL)',
    );
  }
  if (env.REALTIME_DRIVER === 'pusher' && (!env.PUSHER_APP_ID || !env.PUSHER_KEY)) {
    problems.push('REALTIME_DRIVER=pusher needs PUSHER_APP_ID and PUSHER_KEY of the staging app');
  }
  return problems;
}

function gcloud(args: string[]): string {
  return execFileSync('gcloud', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fail(problems: string[]): never {
  const annotate = process.env.GITHUB_ACTIONS === 'true';
  for (const p of problems) console.error(annotate ? `::error title=.env.staging::${p}` : `✗ ${p}`);
  console.error('Staging setup and each value: docs/05-staging.md');
  process.exit(1);
}

function main() {
  const i = process.argv.indexOf('--project');
  const project = i === -1 ? '' : (process.argv[i + 1] ?? '');
  if (!project) fail(['usage: node tools/deploy/staging-preflight.ts --project <gcp-project-id>']);
  const env: EnvFile = parseEnv(readFileSync('.env.staging', 'utf8'));

  let hostname = '';
  try {
    hostname = gcloud([
      'app',
      'describe',
      `--project=${project}`,
      '--format=value(defaultHostname)',
    ]);
  } catch {
    fail([
      `no App Engine app readable in ${project}: check the project id, gcloud app create, IAM`,
    ]);
  }
  let secretState: string | undefined;
  const version = env.SECRETS_VERSION ?? '';
  if (pinned(version)) {
    try {
      secretState = gcloud([
        'secrets',
        'versions',
        'describe',
        version,
        `--secret=${secretName(env)}`,
        `--project=${project}`,
        '--format=value(state)',
      ]);
    } catch {
      secretState = undefined;
    }
  }

  const problems = stagingProblems(env, { project, hostname, secretState });
  if (problems.length > 0) fail(problems);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `url=https://${hostname}\napp_id=${env.PARSE_APP_ID ?? ''}\n`,
    );
  }
  console.log(
    `.env.staging matches ${project}: https://${hostname}, secret version ${env.SECRETS_VERSION}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
