import { AsyncGunzip } from 'fflate';
import type { ITokenizer } from 'strtok3';

export class GzipHandler {
  private tokenizer: ITokenizer;

  constructor(tokenizer: ITokenizer) {
    this.tokenizer = tokenizer;
  }

  async *streamFiles(): AsyncGenerator<ReadableStream<Uint8Array>> {
    let done = false;
    let cancelled = false;

    while (!done) {
      const stream = new ReadableStream<Uint8Array>({
        start: controller => {
          const gunzip = new AsyncGunzip((err, chunk, final) => {
            if (err) {
              controller.error(err);
              return;
            }
            if (chunk && !cancelled) {
              controller.enqueue(chunk);
            }
            if (final && !cancelled) {
              controller.close();
            }
          });

          (async () => {
            try {
              const chunkSize = 1024;
              while (true) {
                const buffer = new Uint8Array(chunkSize);
                const size = await this.tokenizer.readBuffer(buffer, { mayBeLess: true });

                if (size === 0) {
                  done = true;
                  gunzip.push(new Uint8Array(0), true);
                  break;
                }

                const last = size < chunkSize;
                gunzip.push(buffer.subarray(0, size), last);
                if (last) break;
              }
            } catch (err) {
              controller.error(err);
            }
          })();
        },
        cancel: () => {
          cancelled = true;
        }
      });

      yield stream;
    }
  }
}
