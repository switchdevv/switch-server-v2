// Port of legacy cloud/files/files.js (function + helper). The file triggers are in ../triggers/index.ts.
import { type CloudDeps, detach, type FunctionTable } from '../context.js';
import { CLOUD_ERRORS } from '../errors.js';
import { findRole, requireUser } from '../guards.js';

export const FILE_CLASS = 'FileObject';

/**
 * Removes the stored file. Legacy sent an un-awaited `DELETE {publicServerURL}/files/<name>` with the
 * master key to itself over the internet; v2 calls the files adapter in-process, still un-awaited (D-5).
 */
function deleteStoredFile(deps: CloudDeps, filename: string): void {
  detach(deps, 'deleteStoredFile', deps.files.deleteFile(filename));
}

/** Legacy `deleteFile(filename)` helper used by the cascading deletes. */
export async function deleteFileByName(deps: CloudDeps, filename: string): Promise<void> {
  const { Parse } = deps;
  const query = new Parse.Query(FILE_CLASS);
  query.equalTo('fileName', filename);
  const obj = await query.first({ useMasterKey: true });
  if (obj) await obj.destroy({ useMasterKey: true });
  deleteStoredFile(deps, filename);
}

export const fileFunctions: FunctionTable = {
  async deleteFile(req, deps) {
    const { Parse } = deps;
    const user = requireUser(req);
    // The role is looked up but not required: staff may delete any file, others only their own.
    const role = await findRole(deps, user);
    const { filename } = req.params as Record<string, unknown>;
    if (!filename) throw CLOUD_ERRORS.FILE_NAME_MISSING;
    const query = new Parse.Query(FILE_CLASS);
    query.equalTo('fileName', filename);
    const obj = await query.first({ useMasterKey: true });
    if (obj !== undefined && (role !== undefined || obj.get('createdBy').id === user.id)) {
      await obj.destroy({ useMasterKey: true });
      deleteStoredFile(deps, filename as string);
      return 1;
    }
    throw CLOUD_ERRORS.USER_UNAUTHORIZED;
  },
};
