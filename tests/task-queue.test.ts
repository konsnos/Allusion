import { TaskQueue } from '../src/frontend/image/TaskQueue';

/** A task whose completion the test controls */
function deferredTask<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  let started = 0;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const task = () => {
    started++;
    return promise;
  };
  return {
    task,
    resolve,
    reject,
    get started() {
      return started;
    },
  };
}

/** Lets queued promise callbacks run */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TaskQueue', () => {
  it('runs at most `concurrency` tasks at once, first-in first-out', async () => {
    const queue = new TaskQueue<number>(2);
    const tasks = [0, 1, 2, 3].map(() => deferredTask<number>());
    const results = tasks.map((t, i) => queue.run(`k${i}`, t.task));
    await flush();

    expect(tasks.map((t) => t.started)).toEqual([1, 1, 0, 0]);
    expect(queue.numRunning).toBe(2);
    expect(queue.numQueued).toBe(2);

    tasks[1].resolve(1);
    await flush();
    expect(tasks.map((t) => t.started)).toEqual([1, 1, 1, 0]);

    tasks[0].resolve(0);
    tasks[2].resolve(2);
    await flush();
    tasks[3].resolve(3);
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3]);
    expect(queue.numRunning + queue.numQueued).toBe(0);
  });

  it('shares one task between requests with the same key', async () => {
    const queue = new TaskQueue<string>(1);
    const blocker = deferredTask<string>();
    const shared = deferredTask<string>();
    const pBlocker = queue.run('blocker', blocker.task);
    // One request while queued, one while running: both join the first
    const p1 = queue.run('same', shared.task);
    const p2 = queue.run('same', shared.task);
    blocker.resolve('b');
    await flush();
    const p3 = queue.run('same', shared.task);
    shared.resolve('done');

    expect(await Promise.all([pBlocker, p1, p2, p3])).toEqual(['b', 'done', 'done', 'done']);
    expect(shared.started).toBe(1);
  });

  it('removes a queued task once every request for it is aborted', async () => {
    const queue = new TaskQueue<void>(1);
    const blocker = deferredTask();
    const dropped = deferredTask();
    const next = deferredTask();
    queue.run('blocker', blocker.task);
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const pA = queue.run('dropped', dropped.task, controllerA.signal);
    const pB = queue.run('dropped', dropped.task, controllerB.signal);
    const pNext = queue.run('next', next.task);

    controllerA.abort();
    await expect(pA).rejects.toMatchObject({ name: 'AbortError' });
    // Still wanted by B
    expect(queue.numQueued).toBe(2);

    controllerB.abort();
    await expect(pB).rejects.toMatchObject({ name: 'AbortError' });
    expect(queue.numQueued).toBe(1);

    blocker.resolve();
    await flush();
    next.resolve();
    await pNext;
    expect(dropped.started).toBe(0);
  });

  it('keeps a queued task that a request without a signal still waits for', async () => {
    const queue = new TaskQueue<string>(1);
    const blocker = deferredTask<string>();
    const kept = deferredTask<string>();
    queue.run('blocker', blocker.task);
    const controller = new AbortController();
    const pAbortable = queue.run('kept', kept.task, controller.signal);
    const pPlain = queue.run('kept', kept.task);

    controller.abort();
    await expect(pAbortable).rejects.toMatchObject({ name: 'AbortError' });
    blocker.resolve('b');
    await flush();
    kept.resolve('ok');
    expect(await pPlain).toBe('ok');
    expect(kept.started).toBe(1);
  });

  it('lets a running task finish when its request is aborted', async () => {
    const queue = new TaskQueue<string>(1);
    const running = deferredTask<string>();
    const controller = new AbortController();
    const p = queue.run('running', running.task, controller.signal);
    await flush();
    expect(running.started).toBe(1);

    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    // A later request for the same key joins the task that is still running
    const again = queue.run('running', running.task);
    running.resolve('finished');
    expect(await again).toBe('finished');
    expect(running.started).toBe(1);
  });

  it('rejects right away when the signal is already aborted', async () => {
    const queue = new TaskQueue<void>(1);
    const task = deferredTask();
    const controller = new AbortController();
    controller.abort();
    await expect(queue.run('k', task.task, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await flush();
    expect(task.started).toBe(0);
  });

  it('passes failures on, and keeps going after a task throws', async () => {
    const queue = new TaskQueue<string>(1);
    const failing = queue.run('fail', () => {
      throw new Error('sync failure');
    });
    const rejecting = queue.run('reject', () => Promise.reject(new Error('async failure')));
    const ok = queue.run('ok', () => Promise.resolve('ok'));

    await expect(failing).rejects.toThrow('sync failure');
    await expect(rejecting).rejects.toThrow('async failure');
    expect(await ok).toBe('ok');
  });
});
