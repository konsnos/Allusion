import fse from 'fs-extra';
import path from 'path';

/** File name (without extension) of the SQLite database. */
export const DB_NAME = 'Allusion';

/** File name (without extension) of a database or backup that is imported on the next start. */
export const DB_TO_IMPORT_NAME = 'DB_TO_IMPORT';

/**
 * Directory in `userData` that holds the database.
 *
 * Allusion used to store it in `<userData>/databases`, but that directory belongs to Chromium (it
 * held WebSQL data) and since Electron 32 Chromium deletes it on startup.
 */
export const DB_DIRECTORY_NAME = 'allusion-db';

const LEGACY_DB_DIRECTORY_NAME = 'databases';

export function getDatabaseDirectory(userDataPath: string): string {
  return path.join(userDataPath, DB_DIRECTORY_NAME);
}

/** Allusion's own files: the database with its WAL/SHM/journal files, and pending imports. */
function isDatabaseFile(fileName: string): boolean {
  return fileName.startsWith(`${DB_NAME}.sqlite`) || fileName.startsWith(`${DB_TO_IMPORT_NAME}.`);
}

/** Moves the database itself last, so an interrupted migration completes on the next start. */
function byDatabaseLast(a: string, b: string): number {
  return Number(a === `${DB_NAME}.sqlite`) - Number(b === `${DB_NAME}.sqlite`);
}

export interface DatabaseMigrationResult {
  /** Names of the moved files. */
  moved: string[];
  /** Directory where conflicting files were kept instead of being overwritten. */
  setAsideDirectory?: string;
}

/**
 * Moves the database files from `<userData>/databases` into {@link getDatabaseDirectory}, leaving
 * Chromium's own files behind. Throws when a file cannot be moved.
 *
 * Synchronous on purpose: it has to complete before the app is ready, because from Electron 32 on
 * Chromium deletes `<userData>/databases` during startup.
 */
export function migrateLegacyDatabaseDirectory(userDataPath: string): DatabaseMigrationResult {
  const legacyDirectory = path.join(userDataPath, LEGACY_DB_DIRECTORY_NAME);
  if (!fse.pathExistsSync(legacyDirectory)) {
    return { moved: [] };
  }
  const files = fse.readdirSync(legacyDirectory).filter(isDatabaseFile).sort(byDatabaseLast);
  if (files.length === 0) {
    return { moved: [] };
  }

  const databaseDirectory = getDatabaseDirectory(userDataPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let targetDirectory = databaseDirectory;
  let setAsideDirectory: string | undefined;

  if (fse.pathExistsSync(path.join(databaseDirectory, `${DB_NAME}.sqlite`))) {
    // Both directories have a database, e.g. because an older Allusion version ran after the
    // migration. Never overwrite the current database: keep the legacy files next to it.
    targetDirectory = setAsideDirectory = path.join(databaseDirectory, `legacy-${timestamp}`);
  } else {
    // Files that would be overwritten don't belong to the incoming database: set them aside.
    const conflicts = files.filter((file) =>
      fse.pathExistsSync(path.join(databaseDirectory, file)),
    );
    if (conflicts.length > 0) {
      setAsideDirectory = path.join(databaseDirectory, `conflicting-${timestamp}`);
      fse.ensureDirSync(setAsideDirectory);
      for (const file of conflicts) {
        fse.moveSync(path.join(databaseDirectory, file), path.join(setAsideDirectory, file));
      }
    }
  }

  fse.ensureDirSync(targetDirectory);
  for (const file of files) {
    fse.moveSync(path.join(legacyDirectory, file), path.join(targetDirectory, file));
  }
  return { moved: files, setAsideDirectory };
}
