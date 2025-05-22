import * as fs from 'node:fs/promises';
import { ReadableStream } from 'node:stream/web';
import { StringType } from 'token-types';
import type { ITokenizer } from 'strtok3';

export async function makeReadableByteFileStream(filename: string, delay = 0): Promise<{ stream: ReadableStream<Uint8Array>, closeFile: () => Promise<void> }> {

  let position = 0;
  const fileHandle = await fs.open(filename, 'r');

  return {
    stream: new ReadableStream({
      type: 'bytes',

      async pull(controller) {

        // @ts-ignore
        const view = controller.byobRequest.view;

        setTimeout(async () => {
          try {
            const {bytesRead} = await fileHandle.read(view, 0, view.byteLength, position);
            if (bytesRead === 0) {
              await fileHandle.close();
              controller.close();
              // @ts-ignore
              controller.byobRequest.respond(0);
            } else {
              position += bytesRead;
              // @ts-ignore
              controller.byobRequest.respond(bytesRead);
            }
          } catch (err) {
            controller.error(err);
            await fileHandle.close();
          }
        }, delay);
      },

      cancel() {
        return fileHandle.close();
      },

      autoAllocateChunkSize: 1024
    }),
    closeFile: () => {
      return fileHandle.close();
    }
  };
}

export async function isTarHeaderChecksumMatches(tokenizer: ITokenizer): Promise<boolean> {
  const blockSize = 512;
  const typeFlagOffset = 156;

  while (true) {
    const header = new Uint8Array(blockSize);
    const size = await tokenizer.peekBuffer(header, { mayBeLess: true });

    if (size < blockSize) {
      break;
    }

    if (header.every(byte => byte === 0)) {
      break;
    }

    const typeflag = String.fromCharCode(header[typeFlagOffset]);

    const rawSumStr = new StringType(8, 'ascii').get(header, 148);
    const cleanedSumStr = rawSumStr.replace(/\0.*$/, '').trim();

    if (cleanedSumStr === '') {
      await tokenizer.ignore(blockSize);
      continue;
    }

    const readSum = Number.parseInt(cleanedSumStr, 8);

    if (Number.isNaN(readSum)) {
      await tokenizer.ignore(blockSize);
      continue;
    }

    let sum = 0;
    for (let i = 0; i < blockSize; i++) {
      sum += (i >= 148 && i < 156) ? 0x20 : header[i];
    }

    if (readSum === sum) {
      if (typeflag !== 'g' && typeflag !== 'x') {
        return true;  // Found valid regular header
      }
    }

    await tokenizer.ignore(blockSize);
  }

  return false;
}

export function isTarHeaderBySignature(arrayBuffer: Uint8Array, offset = 0) {
  const magicBytes = new StringType(6, 'ascii').get(arrayBuffer, 257);
  return magicBytes === 'ustar\0' || magicBytes === 'ustar '; // POSIX or GNU variant
}
