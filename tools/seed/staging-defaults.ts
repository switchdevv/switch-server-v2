// `pnpm staging:defaults`: gives the existing staging database the column defaults production has.
//
// Staging was seeded before tools/seed/schema.json carried production's `defaultValue`s, so a row
// created there without one of those columns stays without it: a restaurant made in ops has no
// `rating`, and the food app's home screen fails on it. The seed can't fix a database that
// already exists (Parse refuses to change a column that exists), so this writes to MongoDB directly:
//
// 1. each default from schema.json into `_SCHEMA` (`_metadata.fields_options.<column>.defaultValue`,
//    where Parse keeps them). Staging's schema hooks reload the server's schema cache on that change;
//    a new deploy or instance reads it anyway.
// 2. the default into every row that lacks the column (missing only: an explicit null is left alone).
//
// It prints what it would change and writes nothing unless given --apply. It reads the staging
// config like `pnpm seed:staging` (`gcloud auth application-default login` first) and refuses any
// database but `switch_staging`.
//
//   pnpm staging:defaults              → dry run
//   pnpm staging:defaults -- --apply   → writes
import { readFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';
import { loadConfig } from '../../src/config/load.js';

const STAGING_DATABASE = 'switch_staging';
const apply = process.argv.includes('--apply');

interface SchemaClass {
  className: string;
  fields: Record<string, { defaultValue?: unknown }>;
}

const schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8')) as {
  classes: SchemaClass[];
};
const defaults = schema.classes
  .map((cls) => ({
    className: cls.className,
    columns: Object.entries(cls.fields)
      .filter(([, field]) => field.defaultValue !== undefined)
      .map(([name, field]) => ({ name, value: field.defaultValue })),
  }))
  .filter((cls) => cls.columns.length > 0);

const env = await loadConfig({ APP_ENV: 'staging', LOG_LEVEL: 'warn' }).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(
    /credentials/i.test(message)
      ? `${message}\nRun \`gcloud auth application-default login\` first (docs/05-staging.md).`
      : message,
  );
});

const mongo = new MongoClient(env.DATABASE_URI);
try {
  await mongo.connect();
  const db = mongo.db();
  if (db.databaseName !== STAGING_DATABASE) {
    throw new Error(
      `Refusing database "${db.databaseName}": this only runs on ${STAGING_DATABASE}.`,
    );
  }
  const schemas = db.collection<Record<string, unknown>>('_SCHEMA');
  const lines: string[] = [];

  for (const { className, columns } of defaults) {
    const stored = await schemas.findOne({ _id: className as never });
    if (!stored) {
      lines.push(`${className}: not in _SCHEMA, skipped`);
      continue;
    }
    const options =
      (stored._metadata as { fields_options?: Record<string, { defaultValue?: unknown }> })
        ?.fields_options ?? {};
    const rows = db.collection(className);

    for (const { name, value } of columns) {
      if (stored[name] === undefined) {
        lines.push(`${className}.${name}: no such column, skipped`);
        continue;
      }
      const hasDefault = JSON.stringify(options[name]?.defaultValue) === JSON.stringify(value);
      const missing = { [name]: { $exists: false } };
      const count = await rows.countDocuments(missing);
      lines.push(
        `${className}.${name} = ${JSON.stringify(value)}: ` +
          `${hasDefault ? 'default already set' : 'default to set'}, ${count} row(s) without it`,
      );
      if (!apply) continue;
      if (!hasDefault) {
        await schemas.updateOne(
          { _id: className as never },
          { $set: { [`_metadata.fields_options.${name}.defaultValue`]: value } },
        );
      }
      if (count > 0) await rows.updateMany(missing, { $set: { [name]: value } });
    }
  }

  process.stdout.write(
    [
      `${apply ? 'Applied to' : 'Dry run on'} ${db.databaseName} (${env.PARSE_PUBLIC_SERVER_URL}):`,
      ...lines.map((line) => `  ${line}`),
      apply ? '' : '\nNothing written. Run again with `-- --apply` to write.',
      '',
    ].join('\n'),
  );
} finally {
  await mongo.close();
}
