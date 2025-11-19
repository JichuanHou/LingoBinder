import { LibraryBook, Segment } from "../types";

const DB_NAME = "LingoBinderDB";
const DB_VERSION = 4;

// Stores
const STORE_BOOKS = "books";
const STORE_FILES = "files"; // Stores raw EPUB blobs
const STORE_TRANSLATIONS = "translations";
const STORE_PROGRESS = "progress";

interface StoredTranslation {
  id: string; // Composite key: bookId_chapterHref
  segments: Record<string, string>; // segmentId -> translatedText
}

export interface ReadingProgress {
  bookId: string;
  chapterIndex: number;
  segmentId: string;
  updatedAt: number;
}

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES); // Key will be bookId
      }
      if (!db.objectStoreNames.contains(STORE_TRANSLATIONS)) {
        db.createObjectStore(STORE_TRANSLATIONS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
        db.createObjectStore(STORE_PROGRESS, { keyPath: "bookId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
  });
};

export const db = {
  addBook: async (bookMeta: LibraryBook, file: Blob) => {
    const db = await openDB();
    const tx = db.transaction([STORE_BOOKS, STORE_FILES], "readwrite");
    
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);

      tx.objectStore(STORE_BOOKS).put(bookMeta);
      tx.objectStore(STORE_FILES).put(file, bookMeta.id);
    });
  },

  getBooks: async (): Promise<LibraryBook[]> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_BOOKS, "readonly");
      const request = tx.objectStore(STORE_BOOKS).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  getBookFile: async (id: string): Promise<Blob | undefined> => {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_FILES, "readonly");
      const request = tx.objectStore(STORE_FILES).get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  deleteBook: async (id: string) => {
    const db = await openDB();
    
    const stores = [STORE_BOOKS, STORE_FILES];
    if (db.objectStoreNames.contains(STORE_PROGRESS)) stores.push(STORE_PROGRESS);

    // 1. Delete Book & File & Progress (Critical path)
    const tx = db.transaction(stores, "readwrite");
    tx.objectStore(STORE_BOOKS).delete(id);
    tx.objectStore(STORE_FILES).delete(id);
    if (db.objectStoreNames.contains(STORE_PROGRESS)) {
        tx.objectStore(STORE_PROGRESS).delete(id);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // 2. Cleanup Translations (Best effort)
    if (db.objectStoreNames.contains(STORE_TRANSLATIONS)) {
        try {
            const txTrans = db.transaction([STORE_TRANSLATIONS], "readwrite");
            const range = IDBKeyRange.bound(`${id}_`, `${id}_\uffff`);
            txTrans.objectStore(STORE_TRANSLATIONS).delete(range);
            
            await new Promise<void>((resolve) => {
                txTrans.oncomplete = () => resolve();
                txTrans.onerror = () => {
                    console.warn("Translation cleanup failed silently");
                    resolve();
                };
            });
        } catch (e) {
            console.warn("Could not initiate translation cleanup", e);
        }
    }
  },

  saveTranslations: async (bookId: string, chapterHref: string, segments: Segment[]) => {
    // Filter only segments that have translations
    const translatedMap: Record<string, string> = {};
    let hasContent = false;
    
    segments.forEach(s => {
      if (s.translatedText) {
        translatedMap[s.id] = s.translatedText;
        hasContent = true;
      }
    });

    if (!hasContent) return;

    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_TRANSLATIONS)) return; 

    const tx = db.transaction(STORE_TRANSLATIONS, "readwrite");
    const id = `${bookId}_${chapterHref}`;
    
    const store = tx.objectStore(STORE_TRANSLATIONS);
    
    return new Promise<void>((resolve, reject) => {
       const getReq = store.get(id);
       getReq.onsuccess = () => {
         const existing = getReq.result as StoredTranslation | undefined;
         const merged = {
            id,
            segments: { ...(existing?.segments || {}), ...translatedMap }
         };
         store.put(merged);
       };
       
       tx.oncomplete = () => resolve();
       tx.onerror = () => reject(tx.error);
    });
  },

  getTranslations: async (bookId: string, chapterHref: string): Promise<Record<string, string>> => {
    const db = await openDB();
    if (!db.objectStoreNames.contains(STORE_TRANSLATIONS)) return {};

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_TRANSLATIONS, "readonly");
      const id = `${bookId}_${chapterHref}`;
      const request = tx.objectStore(STORE_TRANSLATIONS).get(id);
      request.onsuccess = () => {
        const result = request.result as StoredTranslation | undefined;
        resolve(result ? result.segments : {});
      };
      request.onerror = () => reject(request.error);
    });
  },

  saveProgress: async (bookId: string, chapterIndex: number, segmentId: string) => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_PROGRESS)) return;

      const progress: ReadingProgress = {
          bookId,
          chapterIndex,
          segmentId,
          updatedAt: Date.now()
      };

      const tx = db.transaction(STORE_PROGRESS, "readwrite");
      tx.objectStore(STORE_PROGRESS).put(progress);
      
      return new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
      });
  },

  getProgress: async (bookId: string): Promise<ReadingProgress | undefined> => {
      const db = await openDB();
      if (!db.objectStoreNames.contains(STORE_PROGRESS)) return undefined;

      return new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_PROGRESS, "readonly");
          const request = tx.objectStore(STORE_PROGRESS).get(bookId);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
      });
  }
};