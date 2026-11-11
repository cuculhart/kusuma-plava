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
  /** v0.11: 文書 fingerprint（createdAt + タイトル）— 別文書の
      下書きを誤復元しないための照合キー。旧形式は欠落 */
  fp?: string;
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

/** 下書きを保存し、保存時刻（ISO）を返す。失敗時は null。
    fp = 文書 fingerprint（v0.11 — 誤復元抑止の照合キー） */
export async function saveDraft(
  slm: Uint8Array,
  fp?: string,
): Promise<string | null> {
  try {
    const db = await openDb();
    const at = new Date().toISOString();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(
        { at, slm, fp } satisfies DraftRec,
        KEY,
      );
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

/** 下書きを明示削除する（v0.11 — 自動保存のクリアUI用）。
    失敗しても静かに終わる（表示側は setDraftAt(null) で畳む） */
export async function clearDraft(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch {
    /* 削除失敗は握り潰す — 次回自動保存で上書きされる */
  }
}

// ── v1.1: 升目の背景画像 — アプリ共通設定（全書で共有）。
// 下書きと同じ kv ストアへ別キーで1レコード。書庫・Undo の
// 対象外（.chkpf を膨らませない）──
const BG_KEY = 'bgimg';

export interface BgImgRec {
  /** dataURL（FileReader 由来） */
  url: string;
  /** 透過率 0〜1 */
  alpha: number;
  /** フィット方式 — cover / contain / tile（repeat） */
  fit: 'cover' | 'contain' | 'tile';
  /** 用紙に表示 — true(欠落): 用紙全体へ敷く（升目枠内は
      マスの背景色・透過がベールとして重なる）/
      false: 用紙の外（作業面）にだけ表示。
      旧レコードの scope フィールド（inside/outside）は
      読み捨て — いずれも paper 扱い */
  paper?: boolean;
}

/** 背景画像設定を保存（null で削除）。失敗は静かに諦める */
export async function saveBgImg(rec: BgImgRec | null): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      if (rec) tx.objectStore(STORE).put(rec, BG_KEY);
      else tx.objectStore(STORE).delete(BG_KEY);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch {
    /* 保存失敗は握り潰す — 画面表示だけの装飾なので */
  }
}

/** 背景画像設定を読む。無ければ null */
export async function loadBgImg(): Promise<BgImgRec | null> {
  try {
    const db = await openDb();
    const rec = await new Promise<BgImgRec | null>((res, rej) => {
      const rq = db.transaction(STORE).objectStore(STORE).get(BG_KEY);
      rq.onsuccess = () => res((rq.result as BgImgRec) ?? null);
      rq.onerror = () => rej(rq.error);
    });
    db.close();
    return rec;
  } catch {
    return null;
  }
}
