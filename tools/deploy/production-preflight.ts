// Deploy preflight for production, run by .github/workflows/deploy-production.yml before `gcloud
// app deploy` (and by you, to check a setup): the committed .env.prod must describe the project it
// is about to be deployed to, and that project must be the one serving api.switchfood.net.
// Otherwise the new version would only crash-loop on App Engine (a wrong secret), or be deployed
// somewhere production traffic never reaches. Read-only: it reads .env.prod and asks gcloud for
// the App Engine app, its domain mappings and the state of the pinned secret version, never for
// the secret itself.
//
//   node tools/deploy/production-preflight.ts --project <production GCP project id>
//
// Node runs this TypeScript file as is (type stripping), so it imports only node: modules.
// Outputs for the workflow (GITHUB_OUTPUT): url, app_host, secret_version, dispatch_worker.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

/** The production Parse URL: every app, console and email link uses it. */
export const PRODUCTION_URL = 'https://api.switchfood.net';

export interface ProductionFacts {
  /** The GCP project the workflow deploys to. */
  project: string;
  /** Domains mapped to that project's App Engine app (`gcloud app domain-mappings list`). */
  mappedDomains: string[];
  /** State of the pinned secret version (ENABLED, DISABLED, DESTROYED); undefined when missing. */
  secretState: string | undefined;
}

type EnvFile = Record<string, string | undefined>;

const secretName = (env: EnvFile) => env.SECRETS_NAME || 'switch-server-env';
const pinned = (version: string | undefined) => /^[1-9]\d*$/.test(version ?? '');
const enabled = (value: string | undefined) => value === undefined || /^(true|1)$/.test(value);

/** What stops this .env.prod from being deployed to that project. Empty means go. */
export function productionProblems(env: EnvFile, facts: ProductionFacts): string[] {
  const problems: string[] = [];
  const host = new URL(PRODUCTION_URL).hostname;
  if (!facts.mappedDomains.includes(host)) {
    problems.push(
      `${host} is not mapped to ${facts.project}'s App Engine app: production traffic would never ` +
        'reach this deploy (check --project and the PROD_GCP_PROJECT_ID variable)',
    );
  }
  if (env.SECRETS_SOURCE !== 'gcp') problems.push('SECRETS_SOURCE must be gcp');
  if (env.SECRETS_PROJECT !== facts.project) {
    problems.push(
      `SECRETS_PROJECT is "${env.SECRETS_PROJECT ?? ''}" but the deploy goes to ${facts.project}: ` +
        `set SECRETS_PROJECT=${facts.project}`,
    );
  }
  if (!pinned(env.SECRETS_VERSION)) {
    problems.push(
      'SECRETS_VERSION is not set: add the secret with `pnpm production:secret`, then commit .env.prod',
    );
  } else if (facts.secretState !== 'ENABLED') {
    problems.push(
      `secret ${secretName(env)} version ${env.SECRETS_VERSION} is ` +
        `${facts.secretState?.toLowerCase() ?? 'missing'} in ${facts.project}`,
    );
  }
  // Parse is mounted at `/`, and email links are built from this URL.
  const publicUrl = env.PARSE_PUBLIC_SERVER_URL ?? '';
  if (!URL.canParse(publicUrl) || new URL(publicUrl).href !== `${PRODUCTION_URL}/`) {
    problems.push(`PARSE_PUBLIC_SERVER_URL is "${publicUrl}": set it to ${PRODUCTION_URL}`);
  }
  // Behind App Engine's proxy every request comes from loopback; without this header the master
  // key's IP list is meaningless (docs/05-staging.md, "Check the master key is closed").
  if (env.CLIENT_IP_HEADER?.trim().toLowerCase() !== 'x-appengine-user-ip') {
    problems.push('CLIENT_IP_HEADER must be x-appengine-user-ip');
  }
  if (env.REALTIME_DRIVER === 'pusher' && (!env.PUSHER_APP_ID || !env.PUSHER_KEY)) {
    problems.push(
      'REALTIME_DRIVER=pusher needs PUSHER_APP_ID and PUSHER_KEY of the production Pusher app',
    );
  }
  if (env.SHARED_PROD_CREDENTIALS) {
    problems.push('SHARED_PROD_CREDENTIALS is staging-only: remove it from .env.prod');
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
  for (const p of problems) console.error(annotate ? `::error title=.env.prod::${p}` : `✗ ${p}`);
  console.error('Production setup and each value: docs/06-production.md');
  process.exit(1);
}

function main() {
  const i = process.argv.indexOf('--project');
  const project = i === -1 ? '' : (process.argv[i + 1] ?? '');
  if (!project) {
    fail(['usage: node tools/deploy/production-preflight.ts --project <gcp-project-id>']);
  }
  const env: EnvFile = parseEnv(readFileSync('.env.prod', 'utf8'));

  let appHost = '';
  let mappedDomains: string[] = [];
  try {
    appHost = gcloud([
      'app',
      'describe',
      `--project=${project}`,
      '--format=value(defaultHostname)',
    ]);
  } catch {
    fail([
      `no App Engine app readable in ${project}: check the project id and the deployer's roles`,
    ]);
  }
  try {
    mappedDomains = gcloud([
      'app',
      'domain-mappings',
      'list',
      `--project=${project}`,
      '--format=value(id)',
    ])
      .split('\n')
      .map((d) => d.trim())
      .filter(Boolean);
  } catch {
    fail([
      `can't list ${project}'s domain mappings: the deployer needs roles/appengine.appViewer ` +
        '(docs/06-production.md, step 7)',
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

  const problems = productionProblems(env, { project, mappedDomains, secretState });
  if (problems.length > 0) fail(problems);
  const dispatchWorker = enabled(env.DISPATCH_WORKER_ENABLED) ? 'on' : 'off';
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `url=${PRODUCTION_URL}\napp_host=${appHost}\nsecret_version=${version}\n` +
        `dispatch_worker=${dispatchWorker}\n`,
    );
  }
  console.log(
    `.env.prod matches ${project} (${appHost}, serving ${PRODUCTION_URL}): ` +
      `secret version ${version}, dispatch worker ${dispatchWorker}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
