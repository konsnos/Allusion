import fse from 'fs-extra';
import os from 'os';
import path from 'path';
import { getDatabaseDirectory, migrateLegacyDatabaseDirectory } from '../common/database-location';

describe('migrateLegacyDatabaseDirectory', () => {
  let userData: string;
  const legacy = (file: string) => path.join(userData, 'databases', file);
  const current = (file: string) => path.join(getDatabaseDirectory(userData), file);
  const write = (filePath: string, content: string) => fse.outputFileSync(filePath, content);
  const read = (filePath: string) => fse.readFileSync(filePath, 'utf8');

  beforeEach(() => {
    userData = fse.mkdtempSync(path.join(os.tmpdir(), 'allusion-db-location-'));
  });

  afterEach(() => {
    fse.removeSync(userData);
  });

  it('does nothing without a legacy directory', () => {
    expect(migrateLegacyDatabaseDirectory(userData)).toEqual({ moved: [] });
    expect(fse.pathExistsSync(getDatabaseDirectory(userData))).toBe(false);
  });

  it('moves the database files and leaves Chromium files behind', () => {
    write(legacy('Allusion.sqlite'), 'db');
    write(legacy('Allusion.sqlite-wal'), 'wal');
    write(legacy('Allusion.sqlite-shm'), 'shm');
    write(legacy('DB_TO_IMPORT.json'), 'import');
    write(legacy('Databases.db'), 'chromium');

    const result = migrateLegacyDatabaseDirectory(userData);

    expect([...result.moved].sort()).toEqual([
      'Allusion.sqlite',
      'Allusion.sqlite-shm',
      'Allusion.sqlite-wal',
      'DB_TO_IMPORT.json',
    ]);
    expect(result.moved[result.moved.length - 1]).toBe('Allusion.sqlite');
    expect(result.setAsideDirectory).toBeUndefined();
    expect(read(current('Allusion.sqlite'))).toBe('db');
    expect(read(current('Allusion.sqlite-wal'))).toBe('wal');
    expect(read(current('Allusion.sqlite-shm'))).toBe('shm');
    expect(read(current('DB_TO_IMPORT.json'))).toBe('import');
    expect(fse.readdirSync(path.join(userData, 'databases'))).toEqual(['Databases.db']);
  });

  it('does nothing when run again', () => {
    write(legacy('Allusion.sqlite'), 'db');
    migrateLegacyDatabaseDirectory(userData);

    expect(migrateLegacyDatabaseDirectory(userData)).toEqual({ moved: [] });
    expect(read(current('Allusion.sqlite'))).toBe('db');
  });

  it('completes a migration that was interrupted before the database was moved', () => {
    write(current('Allusion.sqlite-wal'), 'wal');
    write(legacy('Allusion.sqlite'), 'db');

    const result = migrateLegacyDatabaseDirectory(userData);

    expect(result).toEqual({ moved: ['Allusion.sqlite'] });
    expect(read(current('Allusion.sqlite'))).toBe('db');
    expect(read(current('Allusion.sqlite-wal'))).toBe('wal');
  });

  it('never overwrites a database that is already in the new directory', () => {
    write(current('Allusion.sqlite'), 'current');
    write(legacy('Allusion.sqlite'), 'legacy');
    write(legacy('Allusion.sqlite-wal'), 'legacy wal');

    const result = migrateLegacyDatabaseDirectory(userData);

    expect(read(current('Allusion.sqlite'))).toBe('current');
    expect(fse.pathExistsSync(current('Allusion.sqlite-wal'))).toBe(false);
    expect(result.setAsideDirectory).toBeDefined();
    expect(read(path.join(result.setAsideDirectory!, 'Allusion.sqlite'))).toBe('legacy');
    expect(read(path.join(result.setAsideDirectory!, 'Allusion.sqlite-wal'))).toBe('legacy wal');
  });

  it('sets aside files that would be overwritten when there is no database yet', () => {
    write(current('DB_TO_IMPORT.json'), 'stale import');
    write(legacy('Allusion.sqlite'), 'db');
    write(legacy('DB_TO_IMPORT.json'), 'import');

    const result = migrateLegacyDatabaseDirectory(userData);

    expect(read(current('Allusion.sqlite'))).toBe('db');
    expect(read(current('DB_TO_IMPORT.json'))).toBe('import');
    expect(read(path.join(result.setAsideDirectory!, 'DB_TO_IMPORT.json'))).toBe('stale import');
  });
});
