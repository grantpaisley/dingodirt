/* tiny IndexedDB wrapper — Nav's, with a Studio database.
   One store 'files', keyPath 'id'; records discriminated by `kind`:
   basemap / hillshade blobs, scheme-<slug> records, cue caches. */
export const idb = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('dingostudio', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
      r.onsuccess = () => { idb.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode) { return idb.db.transaction('files', mode).objectStore('files'); },
  put(rec) { return new Promise((res, rej) => { const q = idb.tx('readwrite').put(rec); q.onsuccess = res; q.onerror = () => rej(q.error); }); },
  del(id) { return new Promise((res, rej) => { const q = idb.tx('readwrite').delete(id); q.onsuccess = res; q.onerror = () => rej(q.error); }); },
  get(id) { return new Promise((res, rej) => { const q = idb.tx('readonly').get(id); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  all() { return new Promise((res, rej) => { const q = idb.tx('readonly').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
};
