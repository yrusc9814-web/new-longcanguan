/** FIFO 队列。前一项结束或失败后才开始下一项。 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.tail.then(callback);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
