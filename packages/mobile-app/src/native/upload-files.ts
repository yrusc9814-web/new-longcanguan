import { Capacitor, registerPlugin } from '@capacitor/core';
import { sha256Hex } from '../modules/uploads/codec.js';

export interface UploadFileStat {
  readonly exists: boolean;
  readonly size: number;
  readonly sha256: string;
}

interface FileWrite {
  readonly path: string;
  readonly data: Uint8Array;
}

interface RestoreMarker {
  readonly restoreId: number;
}

export interface UploadsFilesBridge {
  readFile(options: { path: string }): Promise<{ data: Uint8Array | null }>;
  writeFile(options: FileWrite): Promise<void>;
  listFiles(options: { prefix?: string }): Promise<{ paths: string[] }>;
  statFile(options: { path: string }): Promise<UploadFileStat>;
  deleteFiles(options: { paths: readonly string[] }): Promise<{ deleted: string[] }>;
  prepareRestore(): Promise<void>;
  writeRestoreFile(options: FileWrite): Promise<void>;
  activateRestore(options: RestoreMarker): Promise<void>;
  recoverRestore(options: RestoreMarker): Promise<void>;
}

function validRelativePath(path: string): boolean {
  return (
    path.length <= 200 &&
    path.split('/').every((part) => part !== '.' && part !== '..' && /^[A-Za-z0-9._-]+$/.test(part))
  );
}

export function createMemoryUploadsFiles(): UploadsFilesBridge {
  let files = new Map<string, Uint8Array>();
  let staged: Map<string, Uint8Array> | undefined;
  let pending: { id: number; previous: Map<string, Uint8Array> } | undefined;

  function write(target: Map<string, Uint8Array>, { path, data }: FileWrite) {
    if (!validRelativePath(path) || data.length === 0) throw new Error('无效的上传文件');
    target.set(path, data.slice());
  }

  return {
    async readFile({ path }) {
      return { data: files.get(path)?.slice() ?? null };
    },
    async writeFile(options) {
      write(files, options);
    },
    async listFiles({ prefix = '' }) {
      return { paths: [...files.keys()].filter((path) => path.startsWith(prefix)).sort() };
    },
    async statFile({ path }) {
      const bytes = files.get(path);
      return bytes
        ? { exists: true, size: bytes.length, sha256: await sha256Hex(bytes) }
        : { exists: false, size: 0, sha256: '' };
    },
    async deleteFiles({ paths }) {
      for (const path of paths) files.delete(path);
      return { deleted: [...paths] };
    },
    async prepareRestore() {
      if (pending) throw new Error('上一次恢复尚未完成');
      staged = new Map();
    },
    async writeRestoreFile(options) {
      if (!staged) throw new Error('恢复暂存区尚未建立');
      write(staged, options);
    },
    async activateRestore({ restoreId }) {
      if (!staged) throw new Error('恢复暂存区尚未建立');
      pending = { id: restoreId, previous: files };
      files = staged;
      staged = undefined;
    },
    async recoverRestore({ restoreId }) {
      if (pending && pending.id !== restoreId) files = pending.previous;
      pending = undefined;
      staged = undefined;
    },
  };
}

type NativeUploadsFiles = Omit<
  UploadsFilesBridge,
  'readFile' | 'writeFile' | 'writeRestoreFile'
> & {
  readFile(options: { path: string }): Promise<{ data?: string | null }>;
  writeFile(options: { path: string; dataBase64: string }): Promise<void>;
  writeRestoreFile(options: { path: string; dataBase64: string }): Promise<void>;
};

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function createNativeUploadsFiles(): UploadsFilesBridge {
  const plugin = registerPlugin<NativeUploadsFiles>('UploadsFiles');
  return {
    async readFile(options) {
      const { data } = await plugin.readFile(options);
      return {
        data: data == null ? null : Uint8Array.from(atob(data), (char) => char.charCodeAt(0)),
      };
    },
    writeFile: ({ path, data }) => plugin.writeFile({ path, dataBase64: encodeBase64(data) }),
    listFiles: async ({ prefix = '' }) => {
      const { paths } = await plugin.listFiles({});
      return { paths: paths.filter((path) => path.startsWith(prefix)) };
    },
    statFile: (options) => plugin.statFile(options),
    deleteFiles: (options) => plugin.deleteFiles(options),
    prepareRestore: () => plugin.prepareRestore(),
    writeRestoreFile: ({ path, data }) =>
      plugin.writeRestoreFile({ path, dataBase64: encodeBase64(data) }),
    activateRestore: (options) => plugin.activateRestore(options),
    recoverRestore: (options) => plugin.recoverRestore(options),
  };
}

export const uploadFiles =
  Capacitor.getPlatform() === 'android' ? createNativeUploadsFiles() : createMemoryUploadsFiles();
