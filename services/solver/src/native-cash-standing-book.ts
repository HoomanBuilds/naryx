import { setTimeout } from 'node:timers/promises';
import { NativeCashMarkUpdating } from '@naryx/adapter-evm';

export class NativeCashBookReadTimeout extends Error {
  constructor() {
    super('Native cash standing book could not be qualified before the read deadline.');
    this.name = 'NativeCashBookReadTimeout';
  }
}

export function createNativeCashStandingBookReader<T>(read: () => Promise<T>, wait = () => setTimeout(1_000)) {
  let pending: Promise<T> | undefined;
  return (): Promise<T> => {
    if (pending !== undefined) return pending;
    let expired = false;
    let timer!: ReturnType<typeof globalThis.setTimeout>;
    const timeout = new NativeCashBookReadTimeout();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = globalThis.setTimeout(() => { expired = true; reject(timeout); }, 8_000);
    });
    const reading = (async () => {
      for (let attempt = 0; ; attempt++) {
        if (expired) throw timeout;
        try {
          const result = await read();
          if (expired) throw timeout;
          return result;
        }
        catch (error) {
          if (expired) throw timeout;
          if (!(error instanceof NativeCashMarkUpdating) || attempt === 4) throw error;
          await wait();
        }
      }
    })();
    pending = Promise.race([reading, deadline]).finally(() => { clearTimeout(timer); pending = undefined; });
    return pending;
  };
}
