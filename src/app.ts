import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { MongoClient } from 'mongodb';
import { ParseServer } from 'parse-server';
import { cryptoRandom } from './adapters/random.js';
import { createPorts } from './adapters/real.js';
import type { CloudDeps, ParseSdk, Random } from './cloud/context.js';
import {
  DRIVER_OFFERS_COLLECTION,
  type DriverOfferDoc,
  MongoDriverOffers,
} from './cloud/driver-offers.js';
import { registerCloud } from './cloud/index.js';
import { MongoOrderClaims, type OrderDoc } from './cloud/order-claims.js';
import { MongoOrderDeclines, type OrderDeclineDoc } from './cloud/order-declines.js';
import { CLASSES } from './cloud/pointers.js';
import { makeDirectAccessWireFaithful } from './cloud/wire-json.js';
import type { Env } from './config/env.js';
import {
  buildParseOptions,
  type FilesAdapterLike,
  trustProxySetting,
} from './config/parse-options.js';
import { createDispatchScheduler, DispatchWorker } from './jobs/choose-driver.js';
import { type JobDoc, LegacyAgendaStore } from './jobs/legacy-agenda-store.js';
import { createLogger, type Logger } from './observability/logger.js';
import type { Ports } from './ports/index.js';

/** The members of a ParseServer instance we use (its published typings model it as a function). */
export interface ParseServerInstance {
  app: express.Handler;
  start(): Promise<unknown>;
}
const ParseServerClass = ParseServer as unknown as new (
  options: Record<string, unknown>,
) => ParseServerInstance;

interface SchemaStream {
  removeAllListeners(event: string): void;
  on(event: string, listener: (error?: unknown) => void): void;
  close(): Promise<void>;
}

interface DatabaseAdapter {
  handleShutdown(): Promise<void>;
  _stream?: SchemaStream;
}

/** Stops accepting connections, closes idle keep-alive ones and waits for in-flight requests. */
function closeHttp(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

export interface AppOverrides {
  ports?: Ports;
  random?: Random;
  logger?: Logger;
  filesAdapter?: FilesAdapterLike;
  authOverrides?: Record<string, unknown>;
  now?: () => Date;
}

export interface SwitchApp {
  app: Express;
  parseServer: ParseServerInstance;
  deps: CloudDeps;
  worker: DispatchWorker;
  agendaStore: LegacyAgendaStore;
  mongo: MongoClient;
  /** Call once the HTTP server is listening, so close() drains it before anything else. */
  attach(server: Server): void;
  close(): Promise<void>;
}

async function createFilesAdapter(env: Env): Promise<FilesAdapterLike> {
  if (env.FILES_DRIVER === 'gridfs') {
    // Plain require: parse-server has no `exports` map and its lib/ is CommonJS.
    const { GridFSBucketAdapter } = createRequire(import.meta.url)(
      'parse-server/lib/Adapters/Files/GridFSBucketAdapter.js',
    ) as {
      GridFSBucketAdapter: new (uri: string) => FilesAdapterLike;
    };
    return new GridFSBucketAdapter(env.DATABASE_URI);
  }
  const { default: S3Adapter } = (await import('@parse/s3-files-adapter')) as unknown as {
    default: new (options: Record<string, unknown>) => FilesAdapterLike;
  };
  // Same effective settings as legacy's bundled 1.4.0 adapter (plan §6.4): public-read objects,
  // one-year cache, URLs `${baseUrl}/${encodeURIComponent(segment)}` (test F-1).
  return new S3Adapter({
    bucket: env.S3_BUCKET,
    baseUrl: env.S3_BASE_URL,
    directAccess: true,
    globalCacheControl: env.S3_CACHE_CONTROL,
    region: env.S3_REGION,
    s3overrides: {
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
      },
    },
  });
}

/** Parse's Mongo storage adapter (private API; pinned by the Parse Server version). */
function databaseAdapter(parseServer: ParseServerInstance): DatabaseAdapter {
  return (
    parseServer as unknown as { config: { databaseController: { adapter: DatabaseAdapter } } }
  ).config.databaseController.adapter;
}

/**
 * Parse 9 watches `_SCHEMA` (schema hooks) with no 'error' listener: a non-resumable change-stream
 * error would be an uncaught exception, and Parse's handler exits the process. Log it instead and
 * drop the stream so Parse re-opens it on the next schema read.
 */
function guardSchemaStream(parseServer: ParseServerInstance, logger: Logger): void {
  const adapter = databaseAdapter(parseServer);
  const stream = adapter._stream;
  if (!stream) return;
  stream.on('error', (error?: unknown) => {
    logger.error({ err: error }, 'schema change stream failed; it will be re-opened');
    if (adapter._stream === stream) adapter._stream = undefined;
  });
}

/** Builds the Express app with Parse Server mounted at `/` (legacy routes: /functions, /classes, …). */
export async function createApp(env: Env, overrides: AppOverrides = {}): Promise<SwitchApp> {
  const logger = overrides.logger ?? createLogger(env.LOG_LEVEL);
  const ports = overrides.ports ?? (await createPorts(env, logger));
  const filesAdapter = overrides.filesAdapter ?? (await createFilesAdapter(env));
  const now = overrides.now ?? (() => new Date());

  const mongo = new MongoClient(env.DATABASE_URI);
  const agendaStore = new LegacyAgendaStore(
    mongo.db().collection<JobDoc>(env.AGENDA_COLLECTION),
    env.AGENDA_LOCK_LIFETIME_MS,
  );

  // `Parse` is only known once Parse Server calls `cloud(Parse)`; deps is completed there.
  const deps = {
    env,
    ports,
    logger,
    random: overrides.random ?? cryptoRandom,
    files: { deleteFile: async (name: string) => void (await filesAdapter.deleteFile(name)) },
    claims: new MongoOrderClaims(mongo.db().collection<OrderDoc>(CLASSES.order), now),
    declines: new MongoOrderDeclines(mongo.db().collection<OrderDeclineDoc>(CLASSES.order), now),
    offers: new MongoDriverOffers(
      mongo.db().collection<DriverOfferDoc>(DRIVER_OFFERS_COLLECTION),
      now,
    ),
  } as Omit<CloudDeps, 'Parse' | 'dispatch'> as CloudDeps;
  const dispatchCtx = { deps, store: agendaStore, now };
  deps.dispatch = createDispatchScheduler(dispatchCtx);
  const worker = new DispatchWorker(dispatchCtx, { processEveryMs: env.AGENDA_PROCESS_EVERY_MS });

  const options = buildParseOptions({
    env,
    filesAdapter,
    emailAdapter: ports.mail,
    authOverrides: overrides.authOverrides,
    cloud: (Parse) => {
      deps.Parse = Parse as ParseSdk;
      registerCloud(deps.Parse, deps);
    },
  });
  const parseServer = new ParseServerClass(options);
  await parseServer.start();
  await mongo.connect();
  guardSchemaStream(parseServer, logger);

  const app = express();
  app.disable('x-powered-by');
  // Parse only applies its trustProxy option in startApp(), which v2 doesn't use. Mounted as a
  // sub-app, Parse inherits this setting, so req.ip (checked against masterKeyIps) is the client.
  const trustProxy = trustProxySetting(env);
  if (trustProxy) app.set('trust proxy', trustProxy);
  // App Engine warmup requests (inbound_services: warmup).
  app.get('/_ah/warmup', (_req, res) => {
    res.status(200).send('ok');
  });
  // Reading `.app` is what installs Parse's directAccess REST controller; wrap it right away.
  const parseApp = parseServer.app;
  makeDirectAccessWireFaithful(deps.Parse);
  app.use('/', parseApp);

  if (env.DISPATCH_WORKER_ENABLED) worker.start();

  let httpServer: Server | undefined;
  let closed = false;
  return {
    app,
    parseServer,
    deps,
    worker,
    agendaStore,
    mongo,
    attach(server) {
      httpServer = server;
    },
    async close() {
      if (closed) return;
      closed = true;
      // 1. Stop taking requests and let in-flight ones finish while every client is still open.
      if (httpServer) await closeHttp(httpServer);
      // 2. Stop the dispatch worker: finish running rounds, release the locks it holds (D-15).
      await worker.stop();
      // 3. Close the databases. Parse 9 opens the schema-hooks change stream without an 'error'
      //    listener, so closing the client under it would throw an uncaught error (and Parse's
      //    handler exits the process). Close the stream first.
      const adapter = databaseAdapter(parseServer);
      if (adapter._stream) {
        const stream = adapter._stream;
        adapter._stream = undefined;
        stream.removeAllListeners('change');
        stream.on('error', () => undefined);
        await stream.close();
      }
      await adapter.handleShutdown();
      await filesAdapter.handleShutdown?.();
      await mongo.close();
    },
  };
}
