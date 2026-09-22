// Files: upload triggers, FileObject bookkeeping, deleteFile (inventory §3.1 #21, §3.3), D-5, D-8.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { client, type Client, eventually, ptr } from '../helpers/client.js';
import { startTestServer, type TestServer } from '../helpers/server.js';
import { makeUser, makeWorld, type World } from '../helpers/world.js';

let server: TestServer;
let api: Client;
let w: World;

async function upload(name: string, session?: string, contentType = 'image/jpeg') {
  const headers: Record<string, string> = {
    'X-Parse-Application-Id': server.appId,
    'Content-Type': contentType,
  };
  if (session) headers['X-Parse-Session-Token'] = session;
  const res = await fetch(`${server.url}/files/${name}`, {
    method: 'POST',
    headers,
    body: Buffer.from('fake-jpeg-bytes'),
  });
  return {
    status: res.status,
    body: (await res.json()) as { name?: string; url?: string; code?: number; error?: string },
  };
}

beforeAll(async () => {
  server = await startTestServer();
  api = client(server);
  w = await makeWorld(api);
});
afterAll(() => server?.close());
beforeEach(() => server.ports.reset());

describe('uploads', () => {
  // 4.3 and 9.x both wrap file-trigger errors in FILE_SAVE_ERROR (130). Without our fileUpload
  // settings 9.x would answer "File upload by public is disabled." before the trigger.
  it('without a session: 130 USER_UNAUTHENTICATED from beforeSaveFile, as legacy', async () => {
    const res = await upload('photo.jpg');
    expect(res.body).toEqual({ code: 130, error: 'USER_UNAUTHENTICATED' });
  });

  it('with a session: stored, and a FileObject row records name + owner', async () => {
    const res = await upload('_Profile.jpeg', w.customer.session);
    expect(res.status).toBe(201);
    expect(res.body.name).toMatch(/^[a-f0-9]{32}__Profile\.jpeg$/);
    const [row] = await api.find('FileObject', { fileName: res.body.name });
    expect(row).toMatchObject({
      fileName: res.body.name,
      createdBy: ptr('_User', w.customer.id),
      file: { __type: 'File', name: res.body.name },
    });
  });

  it('D-8: active-content extensions are refused', async () => {
    const res = await upload('page.html', w.customer.session, 'text/html');
    expect(res.status).toBe(400);
  });
});

describe('deleteFile', () => {
  it("FILE_NAME_MISSING; unknown file or someone else's is USER_UNAUTHORIZED", async () => {
    expect((await api.fn('deleteFile', {}, w.customer.session)).body.error).toBe(
      'FILE_NAME_MISSING',
    );
    expect(
      (await api.fn('deleteFile', { filename: 'nope.jpg' }, w.customer.session)).body.error,
    ).toBe('USER_UNAUTHORIZED');
    const { body } = await upload('mine.jpg', w.customer.session);
    const other = await makeUser(api, { appType: ['food'] });
    expect((await api.fn('deleteFile', { filename: body.name }, other.session)).body.error).toBe(
      'USER_UNAUTHORIZED',
    );
  });

  it('the owner deletes: FileObject row removed, stored bytes removed in-process (D-5)', async () => {
    const { body } = await upload('delete-me.jpg', w.customer.session);
    const files = () =>
      server.switchApp.mongo.db().collection('fs.files').countDocuments({ filename: body.name });
    expect(await files()).toBe(1);
    expect((await api.fn('deleteFile', { filename: body.name }, w.customer.session)).body).toEqual({
      result: 1,
    });
    expect(await api.find('FileObject', { fileName: body.name })).toEqual([]);
    await eventually(async () => (await files()) === 0);
  });

  it("staff (any role) may delete anyone's file", async () => {
    const { body } = await upload('staff-deletes.jpg', w.customer.session);
    expect((await api.fn('deleteFile', { filename: body.name }, w.staffUser.session)).body).toEqual(
      { result: 1 },
    );
  });

  it('assignStoreFile moves the FileObject to the store manager', async () => {
    const { body } = await upload('store-cover.jpg', w.staffUser.session);
    expect(
      (
        await api.fn(
          'assignStoreFile',
          { filename: body.name, storeId: w.storeId },
          w.staffUser.session,
        )
      ).body,
    ).toEqual({ result: 1 });
    const [row] = await api.find('FileObject', { fileName: body.name });
    expect(row!.createdBy).toEqual(ptr('_User', w.manager.id));
  });

  it('deleteProducts removes the product picture through the helper', async () => {
    const { body } = await upload('burger.jpg', w.staffUser.session);
    const foodId = await api.create('Food', {
      name: 'Burger',
      restaurant: ptr('Restaurant', w.storeId),
      picture: { __type: 'File', name: body.name, url: body.url },
    });
    expect((await api.fn('deleteProducts', { ids: [foodId] }, w.staffUser.session)).body).toEqual({
      result: 1,
    });
    expect(await api.find('FileObject', { fileName: body.name })).toEqual([]);
    await eventually(
      async () =>
        (await server.switchApp.mongo
          .db()
          .collection('fs.files')
          .countDocuments({ filename: body.name })) === 0,
    );
  });
});
