/**
 * Mock of S3 AWS Client
 */

import type {GetObjectCommand} from '@aws-sdk/client-s3';
import {readFile} from 'node:fs/promises';
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {Readable} from 'node:stream';

import initDebug from 'debug';
const debug = initDebug('tokenizer:inflate:s3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixture');

function extractRange(rangeStr: string): [number, number] {
  const match = /bytes=(\d+)-(\d+)/.exec(rangeStr);
  if (!match) {
    throw new Error('Invalid range format');
  }
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  return [start, end];
}

export class MockS3Client {

  private numberReads = 0;
  private bytesRead = 0;

  async send(command: GetObjectCommand) {
    if (command.constructor.name === 'GetObjectCommand') {
      const params = command.input; // Extract the command's input
      const range = params.Range ? extractRange(params.Range) : [-1, -1];

      const size = range[1]-range[0] + 1;
      ++this.numberReads;
      this.bytesRead += size;
      debug(`Reading ${size} bytes at offset=${range[0]}`);

      if (command.input.Key) {
        // Metadata requests may leave the body unread, so do not tie a file handle to it.
        const data = await readFile(join(fixturePath, command.input.Key));
        const stream = Readable.from([data.subarray(range[0], range[1] + 1)]);
        return {
          ContentType: 'application/octet-stream',
          ContentRange: `bytes ${range.join('-')}/${data.length}`, // Mock content range
          Body: stream,
        };
      }

      throw new Error('Missing range');
    }

    throw new Error('Unsupported command');
  }

  stats() {
    return {
      bytesRead: this.bytesRead,
      numberReads: this.numberReads
    }
  }
}
