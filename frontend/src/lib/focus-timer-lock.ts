// A readwrite IndexedDB transaction serializes the fallback across tabs.
// The callback must be synchronous so the snapshot is read and written under the same lock.
async function withDatabaseLock<T>(operation: () => T): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("autopilot-focus-coordination", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("lock");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      request.onsuccess = () => request.result.close();
      reject(new Error("Focus coordination database is blocked"));
    };
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction("lock", "readwrite");
      const request = transaction.objectStore("lock").get("focus");
      let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error);
      request.onsuccess = () => {
        try {
          result = operation();
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      };
    });
  } finally {
    db.close();
  }
}

export function withFocusLock<T>(key: string, operation: () => T): Promise<T> {
  if (navigator.locks?.request) return navigator.locks.request(key, operation);
  return withDatabaseLock(operation);
}
