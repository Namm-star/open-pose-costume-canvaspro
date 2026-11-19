import type { GenerationJob, ImageConfig, ImageReference } from './generation';

export interface GenerationRecord {
  id: string;
  createdAt: number;
  model: string;
  size: string;
  quality: ImageConfig['quality'];
  prompt: string;
  references: ImageReference[];
  image: Blob;
}

export type GenerationTask = Pick<
  GenerationJob,
  'model' | 'references' | 'prompt' | 'size' | 'quality'
> & {
  id: string;
  createdAt: number;
};

const databaseName = 'opc-generation-history';
const storeName = 'results';
const taskStoreName = 'tasks';
const historyLimit = 20;

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName))
        db.createObjectStore(storeName, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(taskStoreName)) {
        db.createObjectStore(taskStoreName, { keyPath: 'id' }).createIndex(
          'createdAt',
          'createdAt',
        );
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('historyBlocked'));
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
  store = storeName,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = action(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error || request.error);
      transaction.onerror = () => reject(transaction.error || request.error);
    });
  } finally {
    db.close();
  }
}

export async function listGenerationHistory(): Promise<GenerationRecord[]> {
  const records = await transact<GenerationRecord[]>('readonly', (store) => store.getAll());
  return records.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveGenerationRecord(record: GenerationRecord): Promise<void> {
  await transact('readwrite', (store) => store.put(record));
  const records = await listGenerationHistory();
  for (const old of records.slice(historyLimit)) await deleteGenerationRecord(old.id);
}

export async function deleteGenerationRecord(id: string): Promise<void> {
  await transact('readwrite', (store) => store.delete(id));
}

export function loadGenerationTask(id: string): Promise<GenerationTask | undefined> {
  return transact('readonly', (store) => store.get(id), taskStoreName);
}

export async function saveGenerationTask(task: GenerationTask): Promise<void> {
  await transact(
    'readwrite',
    (store) => {
      const saved = store.put(task);
      const keys = store.index('createdAt').openKeyCursor(null, 'prev');
      let count = 0;
      keys.onsuccess = () => {
        const cursor = keys.result;
        if (!cursor) return;
        if (count++ >= historyLimit) store.delete(cursor.primaryKey);
        cursor.continue();
      };
      return saved;
    },
    taskStoreName,
  );
}

export async function readResultBlob(source: string): Promise<Blob> {
  const url = new URL(source, window.location.href);
  if (!['https:', 'blob:', 'data:'].includes(url.protocol)) throw Error('invalidResult');
  const response = await fetch(url.href, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw Error('invalidResult');
  const blob = await response.blob();
  if (!blob.size || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type))
    throw Error('invalidResult');
  return blob;
}
