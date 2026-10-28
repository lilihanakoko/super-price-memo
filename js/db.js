// IndexedDB の薄いラッパー。データはすべて端末内に保存する（画像は扱わない）。
const DB_NAME = 'super-price-memo';
const DB_VERSION = 1;
export const STORES = ['stores', 'products', 'prices'];

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('stores', { keyPath: 'id' });
      const products = d.createObjectStore('products', { keyPath: 'id' });
      products.createIndex('jan', 'jan');
      const prices = d.createObjectStore('prices', { keyPath: 'id' });
      prices.createIndex('productId', 'productId');
      prices.createIndex('storeId', 'storeId');
      d.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const wrap = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = 'readonly') {
  const d = await openDB();
  return d.transaction(name, mode).objectStore(name);
}

export const db = {
  async all(name) { return wrap((await store(name)).getAll()); },
  async get(name, id) { return id == null ? undefined : wrap((await store(name)).get(id)); },
  async put(name, obj) { await wrap((await store(name, 'readwrite')).put(obj)); return obj; },
  async del(name, id) { return wrap((await store(name, 'readwrite')).delete(id)); },
  async byIndex(name, index, value) { return wrap((await store(name)).index(index).getAll(value)); },
  async clear(name) { return wrap((await store(name, 'readwrite')).clear()); },
  async bulkPut(name, list) {
    const d = await openDB();
    const tx = d.transaction(name, 'readwrite');
    const os = tx.objectStore(name);
    for (const obj of list) os.put(obj);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async kvGet(key) { return wrap((await store('kv')).get(key)); },
  async kvSet(key, value) { return wrap((await store('kv', 'readwrite')).put(value, key)); },
};

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
