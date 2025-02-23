import type { ITokenizer } from 'strtok3';

export class GzipHandler {
  private tokenizer: ITokenizer;

  constructor(tokenizer: ITokenizer) {
    this.tokenizer = tokenizer;
  }

  public inflate(): ReadableStream<Uint8Array> {
    const tokenizer = this.tokenizer;

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const buffer = new Uint8Array(1024);
        const size = await tokenizer.readBuffer(buffer, { mayBeLess: true });

        if (size === 0) {
          controller.close();
          return;
        }

        controller.enqueue(buffer.subarray(0, size));
      }
    }).pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  }
}
