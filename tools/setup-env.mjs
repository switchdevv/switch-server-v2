// Creates .env.local from .env.example with random local keys (never overwrites an existing one).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env.local')) {
  console.log('.env.local already exists; leaving it alone.');
  process.exit(0);
}
const secret = () => randomBytes(18).toString('base64url');
const local = {
  PARSE_MASTER_KEY: secret(),
  PARSE_MAINTENANCE_KEY: secret(),
  GOOGLE_CLIENT_ID: '121610801380-ouhdb4ogsuoervpqaq407fhn4ccobcp0.apps.googleusercontent.com',
  FACEBOOK_APP_IDS: '3475273352569710',
  FILES_DRIVER: 's3',
  S3_ACCESS_KEY_ID: 'switchlocal',
  S3_SECRET_ACCESS_KEY: 'switchlocal-secret',
};
const out = readFileSync('.env.example', 'utf8')
  .split('\n')
  .map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    return m && m[1] in local ? `${m[1]}=${local[m[1]]}` : line;
  })
  .join('\n');
writeFileSync('.env.local', out);
console.log('Wrote .env.local (local keys only). Next: `pnpm dev:all` (docs/04-local-dev.md).');
