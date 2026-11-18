import type { Profile } from "../../api/types";

export interface SavedAccount {
  id: number;
  profile: Profile;
  token?: string;
  expiresAt?: string;
  revision: string;
}
interface StoredAccount {
  key: string;
  base: string;
  id: number;
  profile: Profile;
  expiresAt?: string;
  revision: string;
  iv?: Uint8Array;
  sealed?: ArrayBuffer;
}
const databaseName = "pulse-web-accounts-v1";
let opening: Promise<IDBDatabase> | undefined;
function database() {
  return (opening ||= new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("keys");
      open.result.createObjectStore("accounts", { keyPath: "key" });
    };
    open.onsuccess = () => {
      open.result.onversionchange = () => {
        open.result.close();
        opening = undefined;
      };
      resolve(open.result);
    };
    open.onerror = () => {
      opening = undefined;
      reject(open.error);
    };
    open.onblocked = () => {
      opening = undefined;
      reject(Error("账号存储正在升级，请关闭旧版网页后重试。"));
    };
  }));
}
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () =>
      reject(tx.error || Error("账号存储写入失败"));
  });
const read = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
async function encryptionKey() {
  const db = await database();
  const current = await read<CryptoKey | undefined>(
    db.transaction("keys").objectStore("keys").get("token-key"),
  );
  if (current) return current;
  const generated = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const tx = db.transaction("keys", "readwrite"),
    completed = done(tx),
    store = tx.objectStore("keys");
  const key = await new Promise<CryptoKey>((resolve, reject) => {
    const existing = store.get("token-key");
    existing.onerror = () => reject(existing.error);
    existing.onsuccess = () => {
      const value = existing.result as CryptoKey | undefined;
      if (!value) store.put(generated, "token-key");
      resolve(value || generated);
    };
  });
  await completed;
  return key;
}
export function accountMetadata(profile: Profile): Profile {
  // Never persist login passwords, message bodies or staff-only profile details.
  return {
    id: profile.id,
    user_id: profile.id,
    username: profile.username || "",
    nickname: profile.nickname || profile.username || "账号",
    public_id: profile.public_id || "",
    avatar_url: profile.avatar_url || "",
    signature: "",
  };
}
export function createAccountVault(base: string) {
  const keyFor = (id: number) => base + "|" + id;
  async function list(): Promise<SavedAccount[]> {
    const db = await database();
    const all = await read<StoredAccount[]>(
      db.transaction("accounts").objectStore("accounts").getAll(),
    );
    const key = await encryptionKey();
    return Promise.all(
      all
        .filter(
          (row) =>
            row.base === base && Number.isSafeInteger(row.id) && row.id > 0,
        )
        .map(async (row) => {
          let token: string | undefined;
          if (row.iv && row.sealed)
            try {
              token = new TextDecoder().decode(
                await crypto.subtle.decrypt(
                  {
                    name: "AES-GCM",
                    iv: Uint8Array.from(row.iv),
                    additionalData: new TextEncoder().encode(row.key),
                  },
                  key,
                  row.sealed,
                ),
              );
            } catch {
              /* Keep an expired-account entry so the user can sign in again. */
            }
          return {
            id: row.id,
            profile: row.profile,
            token,
            expiresAt: row.expiresAt,
            revision: row.revision,
          };
        }),
    );
  }
  async function save(account: SavedAccount) {
    if (!Number.isSafeInteger(account.id) || account.id <= 0)
      throw Error("账号标识无效");
    const row: StoredAccount = {
      key: keyFor(account.id),
      base,
      id: account.id,
      profile: accountMetadata(account.profile),
      revision: account.revision,
      expiresAt: account.expiresAt,
    };
    if (account.token) {
      const key = await encryptionKey();
      row.iv = crypto.getRandomValues(new Uint8Array(12));
      row.sealed = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: Uint8Array.from(row.iv),
          additionalData: new TextEncoder().encode(row.key),
        },
        key,
        new TextEncoder().encode(account.token),
      );
    }
    const db = await database(),
      tx = db.transaction("accounts", "readwrite"),
      completed = done(tx);
    tx.objectStore("accounts").put(row);
    await completed;
  }
  async function change(id: number, revision: string, remove = false) {
    const db = await database(),
      tx = db.transaction("accounts", "readwrite"),
      completed = done(tx),
      store = tx.objectStore("accounts");
    let changed: string | undefined;
    const request = store.get(keyFor(id));
    request.onsuccess = () => {
      const row = request.result as StoredAccount | undefined;
      if (!row || row.revision !== revision) return;
      changed = row.revision;
      if (remove) store.delete(row.key);
      else {
        delete row.iv;
        delete row.sealed;
        row.revision = crypto.randomUUID();
        changed = row.revision;
        store.put(row);
      }
    };
    await completed;
    return changed;
  }
  async function profile(id: number, revision: string, value: Profile) {
    const db = await database(),
      tx = db.transaction("accounts", "readwrite"),
      completed = done(tx),
      store = tx.objectStore("accounts"),
      request = store.get(keyFor(id));
    request.onsuccess = () => {
      const row = request.result as StoredAccount | undefined;
      if (row?.revision === revision) {
        row.profile = accountMetadata(value);
        store.put(row);
      }
    };
    await completed;
  }
  return {
    list,
    save,
    profile,
    expire: (id: number, revision: string) => change(id, revision),
    remove: (id: number, revision: string) => change(id, revision, true),
  };
}
