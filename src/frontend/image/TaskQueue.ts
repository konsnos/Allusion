/** The error a {@link TaskQueue} request rejects with when its AbortSignal fires. */
export const createAbortError = (): Error => new DOMException('Aborted', 'AbortError');

interface Entry<T> {
  readonly task: () => Promise<T>;
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  /** Number of requests still waiting for this entry */
  waiters: number;
}

/**
 * Runs keyed async tasks first-in first-out, with at most `concurrency` running at once.
 *
 * - Requests with the same key share one task: while it is queued or running, a new request
 *   waits for the existing one instead of starting it again.
 * - A request can pass an AbortSignal. Aborting rejects that request right away. A queued task
 *   that no request waits for any more is removed without running; a running task is left to
 *   finish, since its result (e.g. a thumbnail on disk) is still useful later.
 */
export class TaskQueue<T> {
  /** Map iteration follows insertion order, which makes it the FIFO queue */
  private readonly queued = new Map<string, Entry<T>>();
  private readonly running = new Map<string, Entry<T>>();

  constructor(private readonly concurrency: number) {
    if (!(concurrency >= 1)) {
      throw new Error(`TaskQueue concurrency must be at least 1, got ${concurrency}`);
    }
  }

  get numQueued(): number {
    return this.queued.size;
  }

  get numRunning(): number {
    return this.running.size;
  }

  run(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }
    const running = this.running.get(key);
    if (running !== undefined) {
      return this.wait(running, signal);
    }

    let entry = this.queued.get(key);
    if (entry === undefined) {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Nobody may be listening any more when an abandoned entry is rejected
      promise.catch(() => {});
      entry = { task, promise, resolve, reject, waiters: 0 };
      this.queued.set(key, entry);
    }
    const result = this.wait(entry, signal, key);
    this.pump();
    return result;
  }

  private wait(entry: Entry<T>, signal?: AbortSignal, queuedKey?: string): Promise<T> {
    entry.waiters++;
    if (signal === undefined) {
      return entry.promise;
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        entry.waiters--;
        reject(createAbortError());
        // Drop the task if it has not started yet and no one else needs it
        if (
          entry.waiters === 0 &&
          queuedKey !== undefined &&
          this.queued.get(queuedKey) === entry
        ) {
          this.queued.delete(queuedKey);
          entry.reject(createAbortError());
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      );
    });
  }

  private pump() {
    while (this.running.size < this.concurrency && this.queued.size > 0) {
      const [key, entry] = this.queued.entries().next().value as [string, Entry<T>];
      this.queued.delete(key);
      this.running.set(key, entry);
      const done = () => {
        this.running.delete(key);
        this.pump();
      };
      // Wrapped in a promise so that a task that throws synchronously is handled the same way
      Promise.resolve().then(entry.task).then(entry.resolve, entry.reject).then(done);
    }
  }
}
