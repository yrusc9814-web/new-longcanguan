import { describe, expect, it } from 'vitest';

import { createMemoryUploadsFiles, validSafetyBackupName } from '../src/native/upload-files.js';
import {
  SAFETY_BACKUP_DIRECTORY,
  createSafetyBackupStore,
  safetyBackupFileName,
} from '../src/sync/safety-backup.js';

const bytes = new Uint8Array([1, 2, 3]);

function backup(name = 'dafan-epoch-1-to-2-2026-03-04T05-06-07-000Z.zip') {
  return {
    name,
    blob: new Blob([bytes]),
    bytes,
    manifest: {
      formatVersion: 1,
      kind: 'epoch-safety' as const,
      createdAt: '2026-03-04T05:06:07.000Z',
      fromEpoch: 1,
      toEpoch: 2,
      tables: [],
      files: {},
    },
  };
}

describe('安全备份独立目录', () => {
  it('默认写入原生独立私有目录，而不是 uploads 同源路径', async () => {
    const files = createMemoryUploadsFiles();
    const writes: { name: string; data: Uint8Array }[] = [];
    const store = createSafetyBackupStore({
      writeSafetyBackup: async (options) => {
        writes.push(options);
        await files.writeSafetyBackup?.(options);
      },
    });

    const path = await store.write(backup());

    expect(path).toBe(`${SAFETY_BACKUP_DIRECTORY}/${backup().name}`);
    expect(writes).toHaveLength(1);
    // 完全没落到 uploads 树里：整库恢复替换上传目录不会动它。
    await expect(files.listFiles({})).resolves.toEqual({ paths: [] });
  });

  it('整库恢复替换 uploads 后备份仍然存在', async () => {
    const files = createMemoryUploadsFiles();
    const store = createSafetyBackupStore({
      writeSafetyBackup: (options) => files.writeSafetyBackup!(options),
    });
    await store.write(backup());
    await files.writeFile({ path: 'main/a.webp', data: bytes });
    await files.prepareRestore();
    await files.writeRestoreFile({ path: 'main/b.webp', data: bytes });
    await files.activateRestore({ restoreId: 7 });

    await expect(files.readFile({ path: 'main/a.webp' })).resolves.toEqual({ data: null });
    // 备份区不受 uploads 替换影响，再次写入同名备份仍然成功。
    await expect(store.write(backup())).resolves.toContain(SAFETY_BACKUP_DIRECTORY);
  });

  it('缺少原生写入口时直接失败，不静默降级到 uploads', async () => {
    const store = createSafetyBackupStore({});
    await expect(store.write(backup())).rejects.toThrow('原生安全备份写入口不可用');
  });

  it('文件名规整为单层 zip，内存实现同样校验', async () => {
    expect(safetyBackupFileName('a/b c.zip')).toBe('a_b_c.zip');
    expect(safetyBackupFileName('plain')).toBe('plain.zip');
    expect(validSafetyBackupName('dafan-epoch-1-to-2.zip')).toBe(true);
    expect(validSafetyBackupName('../escape.zip')).toBe(false);
    expect(validSafetyBackupName('nested/dir.zip')).toBe(false);

    const files = createMemoryUploadsFiles();
    await expect(files.writeSafetyBackup?.({ name: '../escape.zip', data: bytes })).rejects.toThrow(
      '无效的安全备份',
    );
  });
});
