// Prints the prod-leak guard fingerprints for values read from stdin (one per line), hashes only.
// Usage: printf '%s\n' "$VALUE" | pnpm fingerprint
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

for await (const line of createInterface({ input: process.stdin })) {
  if (line) console.log(createHash('sha256').update(line).digest('hex').slice(0, 16));
}
