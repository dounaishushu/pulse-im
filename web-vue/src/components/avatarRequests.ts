import type { Client } from "../api/client";

type Job = {
  key: string;
  token: string;
  id: string;
  force: boolean;
  waiters: number;
  promise: Promise<string>;
  resolve(value: string): void;
  reject(reason: unknown): void;
};
type Queue = { active: number; jobs: Map<string, Job>; pending: Job[] };
const queues = new WeakMap<Client, Queue>();
const viewers = new WeakMap<Client, Map<string, Set<(url: string) => void>>>();

export function shareAvatar(client: Client, id: string, token: string, changed: (url: string) => void) {
  let images = viewers.get(client);
  if (!images) viewers.set(client, images = new Map());
  const key = `${token}|${id}`;
  let listeners = images.get(key);
  if (!listeners) images.set(key, listeners = new Set());
  listeners.add(changed);
  return () => {
    listeners.delete(changed);
    if (!listeners.size) images.delete(key);
  };
}
export function avatarLoaded(client: Client, id: string, token: string, url: string) {
  if (client.token !== token) return;
  for (const changed of viewers.get(client)?.get(`${token}|${id}`) || []) changed(url);
}

// Only visible avatars enter this queue. Share work across the member list and
// profile dialogs, with a per-account limit rather than one request per row.
export function requestAvatar(
  client: Client, id: string, token: string, signal: AbortSignal, force = false,
): Promise<string> {
  signal.throwIfAborted();
  let queue = queues.get(client);
  if (!queue) queues.set(client, queue = { active: 0, jobs: new Map(), pending: [] });
  const state = queue;
  const key = `${token}|${id}|${force}`;
  let job = state.jobs.get(key);
  if (!job) {
    let resolve!: Job["resolve"], reject!: Job["reject"];
    const promise = new Promise<string>((ok, fail) => { resolve = ok; reject = fail; });
    job = { key, token, id, force, waiters: 0, promise, resolve, reject };
    state.jobs.set(key, job);
    state.pending.push(job);
    // A queued avatar may lose every viewer before its turn.
    void promise.catch(() => {});
  }
  const shared = job;
  shared.waiters++;
  function drain() {
    while (state.active < 4 && state.pending.length) {
      const next = state.pending.shift()!;
      if (!next.waiters || client.token !== next.token) {
        state.jobs.delete(next.key);
        next.reject(new DOMException("Avatar view closed", "AbortError"));
        continue;
      }
      state.active++;
      // The adapter aborts HTTP at 15 seconds. Keep this slot until that request
      // finishes so slow connections cannot exceed the four-request limit.
      void client.mediaGrant(next.id, next.token, AbortSignal.timeout(16000), next.force)
        .then(next.resolve, next.reject).finally(() => {
          state.jobs.delete(next.key);
          state.active--;
          drain();
        });
    }
  }
  const result = new Promise<string>((resolve, reject) => {
    const cleanup = () => { signal.removeEventListener("abort", abort); shared.waiters--; };
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    shared.promise.then(value => { if (!signal.aborted) { cleanup(); resolve(value); } }, error => {
      if (!signal.aborted) { cleanup(); reject(error); }
    });
  });
  drain();
  return result;
}

const visibility = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | undefined;
export function observeAvatar(element: Element, changed: (visible: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") { changed(true); return () => {}; }
  observer ||= new IntersectionObserver(entries => {
    for (const entry of entries) visibility.get(entry.target)?.(entry.isIntersecting);
  }, { rootMargin: "100px" });
  visibility.set(element, changed);
  observer.observe(element);
  return () => {
    observer?.unobserve(element);
    visibility.delete(element);
    if (!visibility.size) { observer?.disconnect(); observer = undefined; }
  };
}
