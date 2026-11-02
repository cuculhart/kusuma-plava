// 自動保存（v0.3）— IndexedDB への下書き保管。
// 格納するのは packArchive が出す書庫バイト列そのもの — 保存と同じ
// 直列化経路を使うため、画像を含めて完全な復元ができる。
// IndexedDB 非対応/拒否環境では loadDraft が null を返し、
// saveDraft は静かに失敗する（自動保存を諦めるだけ）。

const DB_NAME = 'kusuma-plava';
const STORE = 'kv';
const KEY = 'draft';

export interface DraftRec {
  /** 保存時刻（ISO）— 「下書き HH:MM」表示用 */
  at: string;
  /** packArchive 出力（書庫 zip） */
  slm: Uint8Array;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => {
      rq.result.createObjectStore(STORE);
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

/** 下書きを保存し、保存時刻（ISO）を返す。失敗時は null。 */
export async function saveDraft(slm: Uint8Array): Promise<string | null> {
  try {
    const db = await openDb();
    const at = new Date().toISOString();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ at, slm } satisfies DraftRec, KEY);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
    return at;
  } catch {
    return null;
  }
}

/** 下書きを読む。無ければ null。壊れていても null（呼出側で握り潰す前提）。 */
export async function loadDraft(): Promise<DraftRec | null> {
  try {
    const db = await openDb();
    const rec = await new Promise<DraftRec | null>((res, rej) => {
      const rq = db.transaction(STORE).objectStore(STORE).get(KEY);
      rq.onsuccess = () => res((rq.result as DraftRec) ?? null);
      rq.onerror = () => rej(rq.error);
    });
    db.close();
    return rec;
  } catch {
    return null;
  }
}
