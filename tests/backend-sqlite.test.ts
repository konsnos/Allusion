import SQLite from 'better-sqlite3';
import fse from 'fs-extra';
import os from 'os';
import path from 'path';
import { OrderDirection } from '../src/api/data-storage-search';
import { FileDTO } from '../src/api/file';
import { LocationDTO } from '../src/api/location';
import { ROOT_TAG_ID, TagDTO } from '../src/api/tag';
import Backend from '../src/backend/backend';
import BackupScheduler from '../src/backend/backup-scheduler';

// Runs the SQLite backend the app uses, including the better-sqlite3 native addon.
describe('SQLite backend', () => {
  const root = fse.mkdtempSync(path.join(os.tmpdir(), 'allusion-backend-'));
  let databaseCount = 0;

  const location: LocationDTO = {
    id: 'location1',
    path: 'C:/images',
    dateAdded: new Date(),
    subLocations: [],
    tags: [],
    index: 0,
    isWatchingFiles: true,
  };

  const tag: TagDTO = {
    id: 'tag1',
    name: 'tag1 name',
    dateAdded: new Date(),
    color: '',
    subTags: [],
    impliedTags: [],
    isHidden: false,
    isVisibleInherited: false,
    aliases: [],
    description: '',
    isHeader: false,
    fileCount: 0,
    isFileCountDirty: true,
  };

  const files: FileDTO[] = [0, 1, 2].map((index) => ({
    id: `file${index}`,
    ino: `${index}`,
    locationId: location.id,
    relativePath: `image ${index}.jpg`,
    absolutePath: `${location.path}/image ${index}.jpg`,
    name: `image ${index}.jpg`,
    extension: 'jpg',
    tags: [],
    tagSorting: 'hierarchy',
    extraProperties: {},
    size: 42,
    width: 640,
    height: 480,
    dateAdded: new Date(),
    dateModified: new Date(),
    dateModifiedOS: new Date(),
    dateLastIndexed: new Date(),
    dateCreated: new Date(),
  }));

  async function createBackend(): Promise<[Backend, string]> {
    const dbPath = path.join(root, `${databaseCount++}`, 'Allusion.sqlite');
    await fse.ensureFile(dbPath);
    const backend = new Backend();
    await backend.init(
      dbPath,
      undefined,
      () => {},
      async () => {},
    );
    return [backend, dbPath];
  }

  beforeAll(() => {
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterAll(() => {
    jest.restoreAllMocks();
    // The databases stay open (Backend can't be closed), which Windows doesn't allow to delete.
    fse.remove(root).catch(() => {});
  });

  it('creates the root tag when initializing a new database', async () => {
    const [backend] = await createBackend();

    const tags = await backend.fetchTags();

    expect(tags.map((t) => t.id)).toContain(ROOT_TAG_ID);
  });

  it('stores and fetches tags, locations and files', async () => {
    const [backend] = await createBackend();

    await backend.createTag(tag);
    await backend.createLocation(location);
    await backend.createFilesFromPath(location.path, files);
    await backend.saveFiles([{ ...files[0], tags: [tag.id] }]);

    expect((await backend.fetchTags()).map((t) => t.id)).toContain(tag.id);
    expect((await backend.fetchLocations()).map((l) => l.path)).toEqual([location.path]);
    const fetched = await backend.fetchFiles('name', OrderDirection.Asc, false);
    expect(fetched.map((f) => f.name)).toEqual(files.map((f) => f.name));
    // Files also have their location's tag
    expect(fetched[0].tags).toEqual([tag.id, location.id]);
    expect(await backend.countFiles({ files: true, untagged: true })).toEqual([3, 2]);
  });

  it('writes backups that can be opened', async () => {
    const [backend, dbPath] = await createBackend();
    await backend.createLocation(location);
    await backend.createFilesFromPath(location.path, files);
    const backupScheduler = new BackupScheduler();
    await backupScheduler.init(dbPath, undefined, undefined);
    const backupPath = path.join(path.dirname(dbPath), 'backup.sqlite');

    await backupScheduler.backupToFile(backupPath);

    const backup = new SQLite(backupPath, { readonly: true });
    try {
      expect(backup.prepare('SELECT COUNT(*) AS count FROM files').get()).toEqual({ count: 3 });
    } finally {
      backup.close();
    }
  });
});
