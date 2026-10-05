/** Retry native transport failures on reads only. HTTP responses and writes stay with their callers. */
export async function retryRead<T>(method: string, work: () => Promise<T>, active: () => boolean,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (!active()) throw new Error('Plugin unloaded.');
    try { return await work(); }
    catch (error) {
      if (method !== 'GET' || attempt >= 2 || !active()) throw error;
      await wait(attempt === 0 ? 250 : 1000);
    }
  }
}
