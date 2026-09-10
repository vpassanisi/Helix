export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.tail.then(operation, operation)
    this.tail = queued.then(() => undefined, () => undefined)
    return queued
  }
}
