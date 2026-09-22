/**
 * Secret Manager loader (staging/production only). One JSON secret per environment, fetched once
 * at boot at a pinned version. The payload is never logged.
 */
export async function fetchSecretJson(opts: {
  project: string;
  name: string;
  version: string;
}): Promise<Record<string, string>> {
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: `projects/${opts.project}/secrets/${opts.name}/versions/${opts.version}`,
  });
  const data = version.payload?.data;
  if (!data) throw new Error(`Secret ${opts.name}@${opts.version} is empty`);
  const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Secret ${opts.name}@${opts.version} must be a JSON object`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') throw new Error(`Secret key ${k} must be a string`);
    out[k] = v;
  }
  await client.close();
  return out;
}
