import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { S3Client } from '@aws-sdk/client-s3';
import { makeChunkedTokenizerFromS3 } from '@tokenizer/s3';
import { assert } from 'chai';
import { it } from 'mocha';
import {
  createTokenizerView,
  fromBuffer,
  fromFile,
  fromStream,
  fromWebStream,
  type IRandomAccessTokenizer,
  type ITokenizer,
  TokenizerBoundaryError
} from 'strtok3';
import { UINT8 } from 'token-types';
import { GzipHandler, type ILocalFileHeader, ZipHandler, ZipLimitError } from '../lib/index.js';
import { MockS3Client } from './S3ClientMockup.js';
import { isTarHeaderChecksumMatches, makeReadableByteFileStream } from './util.js';

import {
  expectLimit,
  extract,
  makeCentralDirectoryZip,
  makeRepeatedZip,
  makeZip,
  makeZipWithTrailingDeflateData,
  stream
} from './zip-util.js';

const chunkSize = 256 * 1024;

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixture');

interface IExtractedFile {
  header: ILocalFileHeader;
  data: Uint8Array;
}

async function extractFilesFromFixture(tokenizer: ITokenizer): Promise<IExtractedFile[]> {
  try {
    const zipHandler = new ZipHandler(tokenizer);
    const files: IExtractedFile[] = [];
    await zipHandler.unzip(zipFile => {
      return {
        handler: async fileData => {
          files.push({
            data: fileData,
            header: zipFile
          });
        },
        stop: false
      };
    });
    return files;
  } finally {
    await tokenizer.close();
  }
}

async function makeFileTokenizer(fixture: string): Promise<IRandomAccessTokenizer> {
  return fromFile(join(fixturePath, fixture));
}

async function makeNodeStreamTokenizer(fixture: string): Promise<ITokenizer> {
  const stream = createReadStream(join(fixturePath, fixture));
  return fromStream(stream);
}

async function makeWebStreamTokenizer(fixture: string): Promise<ITokenizer> {
  const stream = await makeReadableByteFileStream(join(fixturePath, fixture));
  const tokenizer = fromWebStream(stream.stream);
  const closeTokenizer = tokenizer.close.bind(tokenizer);
  tokenizer.close = async () => {
    try {
      await closeTokenizer();
    } finally {
      // Closing the BYOB tokenizer only releases its reader lock, so close the file explicitly.
      await stream.closeFile();
    }
  };
  return tokenizer;
}

async function makeS3Tokenizer(fixture: string): Promise<ITokenizer> {
  const s3Client = new MockS3Client();

  return await makeChunkedTokenizerFromS3(s3Client as unknown as S3Client, {
    Bucket: 'mockup',
    Key: fixture
  });
}

async function checkContentTypesXml(tokenizer: ITokenizer): Promise<void> {
  const files = await extractFilesFromFixture(tokenizer);
  assert.isDefined(files, 'expect list of files');
  const filename = '[Content_Types].xml';
  const contentTypeFile = findFile(files, filename);
  assert.isDefined(contentTypeFile, `Find file "${filename}"`);
  assertFileIsXml(contentTypeFile.data);
}

function findFile(files: IExtractedFile[], filename: string): IExtractedFile | undefined {
  return files.find(file => file.header.filename === filename);
}

function getInflatedFileLength(files: IExtractedFile[], filename: string): number {
  assert.isDefined(files);
  const file = findFile(files, filename);
  assert.isDefined(file, `Find file "${filename}"`);
  return file.data.length;
}

function assertFileIsXml(fileData: Uint8Array) {
  const xmlContent = new TextDecoder('utf-8').decode(fileData);
  assert.strictEqual(xmlContent.indexOf('<?xml version="1.0"'), 0, 'Content is XML');
}

describe('ZipHandler', () => {
  describe('Compression methods and local-header flags', () => {
    it('reads local-header extra fields without a data descriptor', async () => {
      const tokenizer = await makeFileTokenizer('fixture.docx');
      try {
        await checkContentTypesXml(tokenizer);
      } finally {
        await tokenizer.close();
      }
    });

    it('extracts the XLSX content types entry', async () => {
      const tokenizer = await makeFileTokenizer('fixture.xlsx');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.isDefined(files);
        const filename = '[Content_Types].xml';
        const contentTypeFile = findFile(files, filename);
        assert.isDefined(contentTypeFile, `Find file "${filename}"`);
        assert.strictEqual(contentTypeFile.data.length, 1336);
      } finally {
        await tokenizer.close();
      }
    });

    describe('inflate a ZIP file with the "data descriptor" flag set', () => {
      it('from file (with random-read)', async () => {
        const tokenizer = await makeFileTokenizer('file_example_XLSX_10.xlsx');
        try {
          await checkContentTypesXml(tokenizer);
        } finally {
          await tokenizer.close();
        }
      });

      it('from web-stream (without random-read)', async () => {
        const tokenizer = await makeWebStreamTokenizer('file_example_XLSX_10.xlsx');
        try {
          await checkContentTypesXml(tokenizer);
        } finally {
          await tokenizer.close();
        }
      });

      it('from Node.js-stream (without random-read)', async () => {
        const tokenizer = await makeNodeStreamTokenizer('file_example_XLSX_10.xlsx');
        try {
          await checkContentTypesXml(tokenizer);
        } finally {
          await tokenizer.close();
        }
      });
    });

    it('extract uncompressed data', async () => {
      const tokenizer = await makeFileTokenizer('fixture.odp');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        const filename = 'mimetype';
        const file = findFile(files, filename);
        assert.isDefined(file, `Find file "${filename}"`);
        const text = new TextDecoder('utf-8').decode(file.data);
        assert.isDefined(file.data, 'file.data');
        assert.strictEqual(text, 'application/vnd.oasis.opendocument.presentation');
      } finally {
        await tokenizer.close();
      }
    });

    it('inflate deflate', async () => {
      const tokenizer = await makeFileTokenizer('sample-deflate.zip');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.strictEqual(getInflatedFileLength(files, 'sample3.doc'), 15684);
      } finally {
        await tokenizer.close();
      }
    });

    it('inflate deflate64', async () => {
      const tokenizer = await makeFileTokenizer('sample-deflate64.zip');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.strictEqual(getInflatedFileLength(files, 'sample3.doc'), 15684);
      } finally {
        await tokenizer.close();
      }
    });
  });

  describe('ZIP fixture compatibility', () => {
    it('inflate sample-4', async () => {
      const tokenizer = await makeFileTokenizer('sample-zip-files-sample-4.zip');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.strictEqual(getInflatedFileLength(files, 'sample1.doc'), 9779);
      } finally {
        await tokenizer.close();
      }
    });

    it('inflate sample-5', async () => {
      const tokenizer = await makeFileTokenizer('sample-zip-files-sample-5.zip');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.strictEqual(getInflatedFileLength(files, 'sample2.doc'), 10199);
      } finally {
        await tokenizer.close();
      }
    });

    it('inflate sample-6', async () => {
      const tokenizer = await makeFileTokenizer('sample-zip-files-sample-6.zip');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.strictEqual(getInflatedFileLength(files, 'sample3.doc'), 15684);
      } finally {
        await tokenizer.close();
      }
    });

    it('inflate deflate64', async () => {
      const tokenizer = await makeFileTokenizer('sample-deflate64.zip');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.strictEqual(getInflatedFileLength(files, 'sample3.doc'), 15684);
      } finally {
        await tokenizer.close();
      }
    });
  });

  describe('Inflate fixture.zip', () => {
    it('from file', async () => {
      const tokenizer = await makeFileTokenizer('fixture.zip');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.strictEqual(getInflatedFileLength(files, 'test.jpg'), 2248);
      } finally {
        await tokenizer.close();
      }
    });

    it('from web-stream', async () => {
      const tokenizer = await makeWebStreamTokenizer('fixture.zip');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.strictEqual(getInflatedFileLength(files, 'test.jpg'), 2248);
      } finally {
        await tokenizer.close();
      }
    });

    it('from Node.js-stream', async () => {
      const tokenizer = await makeNodeStreamTokenizer('fixture.zip');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.strictEqual(getInflatedFileLength(files, 'test.jpg'), 2248);
      } finally {
        await tokenizer.close();
      }
    });
  });

  describe('Inflate somefile.csv.zip', () => {
    it('from file', async () => {
      const tokenizer = await makeFileTokenizer('somefile.csv.zip');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.strictEqual(getInflatedFileLength(files, 'somefile.csv'), 50);
      } finally {
        await tokenizer.close();
      }
    });

    it('from Node.js-stream', async () => {
      const tokenizer = await makeNodeStreamTokenizer('somefile.csv.zip');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.strictEqual(getInflatedFileLength(files, 'somefile.csv'), 50);
      } finally {
        await tokenizer.close();
      }
    });

    it('from web-stream', async () => {
      const tokenizer = await makeWebStreamTokenizer('somefile.csv.zip');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.strictEqual(getInflatedFileLength(files, 'somefile.csv'), 50);
      } finally {
        await tokenizer.close();
      }
    });

    it('from S3 mockup', async () => {
      const tokenizer = await makeS3Tokenizer('somefile.csv.zip');
      try {
        const files = await extractFilesFromFixture(tokenizer);
        assert.strictEqual(getInflatedFileLength(files, 'somefile.csv'), 50);
      } finally {
        await tokenizer.close();
      }
    });
  });

  describe('Traversal budgets and incremental directories', () => {
    for (const central of [false, true]) {
      for (const selected of [false, true]) {
        it(`bounds visited entries (${central ? 'directory' : 'stream'}, ${selected ? 'selected' : 'ignored'})`, async () => {
          const zip = makeRepeatedZip(3, 10, false, central);
          const tokenizer = central ? fromBuffer(zip) : await stream(zip);
          await expectLimit(extract(tokenizer, { maxEntryCount: 2 }, selected), 'maxEntryCount', 2);
        });
      }
      it(`accepts the exact entry limit (${central ? 'directory' : 'stream'})`, async () => {
        const zip = makeRepeatedZip(2, 10, false, central);
        assert.lengthOf(await extract(central ? fromBuffer(zip) : await stream(zip), { maxEntryCount: 2 }), 2);
      });
    }

    for (const selected of [false, true]) {
      it(`bounds cumulative local-header consumption (${selected ? 'selected' : 'ignored'})`, async () => {
        const zip = makeRepeatedZip(3, 100);
        const tokenizer = await stream(zip);
        await expectLimit(extract(tokenizer, { maxTotalScanBytes: 260 }, selected), 'maxTotalScanBytes', 260);
        assert.equal(tokenizer.position, 260, 'do not consume the next header beyond the budget');
      });
      it(`accepts the exact local-header byte budget (${selected ? 'selected' : 'ignored'})`, async () => {
        const zip = makeRepeatedZip(2, 100);
        await extract(await stream(zip), { maxTotalScanBytes: 260 }, selected);
      });
      it(`bounds descriptor scans across entries (${selected ? 'selected' : 'ignored'})`, async () => {
        await expectLimit(
          extract(await stream(makeRepeatedZip(2, 100, true)), { maxTotalDataDescriptorScanBytes: 199 }, selected),
          'maxTotalDataDescriptorScanBytes',
          199
        );
        await extract(await stream(makeRepeatedZip(2, 100, true)), { maxTotalDataDescriptorScanBytes: 200 }, selected);
      });
    }

    it('bounds ignored known-size entries before skipping their data', async () => {
      const tokenizer = await stream(makeRepeatedZip(1, 101));
      await expectLimit(extract(tokenizer, { maxSkippedEntrySize: 100 }, false), 'maxSkippedEntrySize', 100);
      assert.equal(tokenizer.position, 30);
      await extract(await stream(makeRepeatedZip(1, 100)), { maxSkippedEntrySize: 100 }, false);
    });

    it('bounds ignored descriptor entries and leaves selected entries unaffected', async () => {
      await expectLimit(
        extract(await stream(makeRepeatedZip(1, 101, true)), { maxSkippedEntrySize: 100 }, false),
        'maxSkippedEntrySize',
        100
      );
      await extract(await stream(makeRepeatedZip(1, 101, true)), { maxSkippedEntrySize: 100 });
    });

    it('counts directory lookup, metadata and selected payload reads without counting seek distances', async () => {
      const zip = makeRepeatedZip(2, 100, false, true);
      // EOCD lookup + EOCD header + two directory entries and local headers/payloads.
      const budget = zip.length + 22 + 2 * (46 + 30 + 100);
      await extract(fromBuffer(zip), { maxTotalScanBytes: budget });
      await expectLimit(extract(fromBuffer(zip), { maxTotalScanBytes: budget - 1 }), 'maxTotalScanBytes', budget - 1);
    });

    it('stops before parsing later directory entries, including when an advertised entry count exceeds the limit', async () => {
      const zip = makeRepeatedZip(2, 10, false, true);
      new DataView(zip.buffer).setUint32(80 + 46, 0, true); // Malformed second central entry.
      const tokenizer = fromBuffer(zip);
      let callbacks = 0;
      await new ZipHandler(tokenizer, { maxEntryCount: 1 }).unzip(() => {
        callbacks++;
        return { handler: async data => assert.lengthOf(data, 10), stop: true };
      });
      assert.equal(callbacks, 1);
      assert.equal(tokenizer.position, 0, 'restore source after early return');
      await tokenizer.close();
    });

    it('can opt out of central-directory traversal to retain local-header order and semantics', async () => {
      const zip = makeRepeatedZip(2, 10, false, true);
      new DataView(zip.buffer).setUint32(zip.length - 6, 0, true); // Invalid directory offset, valid local headers.
      assert.lengthOf(await extract(fromBuffer(zip), { useCentralDirectory: false, maxTotalScanBytes: 80 }), 2);
    });

    it('resets archive-wide budgets when the handler is reused', async () => {
      const tokenizer = fromBuffer(makeRepeatedZip(1, 10));
      const handler = new ZipHandler(tokenizer, {
        useCentralDirectory: false,
        maxTotalScanBytes: 40,
        maxEntryCount: 1
      });
      for (let i = 0; i < 2; i++) {
        tokenizer.setPosition(0);
        await handler.unzip(() => ({ handler: false }));
      }
      await tokenizer.close();
    });

    it('checks the entry limit when explicitly collecting the central directory', async () => {
      const tokenizer = fromBuffer(makeRepeatedZip(2, 10, false, true));
      await expectLimit(new ZipHandler(tokenizer, { maxEntryCount: 1 }).readCentralDirectory(), 'maxEntryCount', 1);
      assert.equal(tokenizer.position, 0);
      await tokenizer.close();
    });
  });

  describe('Descriptor candidate validation', () => {
    for (const offset of [5, chunkSize - 12, chunkSize - 4]) {
      it(`ignores embedded signatures with an incorrect compressed size at ${offset}`, async () => {
        const data = new Uint8Array(chunkSize + 40).fill(1);
        const view = new DataView(data.buffer);
        view.setUint32(offset, 0x08074b50, true);
        view.setUint32(offset + 8, 123, true);
        const files = await extract(await stream(makeZip(data, true)), { maxDataDescriptorScanBytes: data.length });
        assert.deepEqual(files, [data]);
      });
    }

    for (const descriptorBytes of [0, 4, 8, 12, 15]) {
      it(`can deliver detection data before rejecting a descriptor truncated to ${descriptorBytes} bytes`, async () => {
        const zip = makeZip(new Uint8Array(100).fill(1), true).subarray(0, 130 + descriptorBytes);
        const tokenizer = await stream(zip);
        let delivered = false;
        try {
          await new ZipHandler(tokenizer, { allowTruncatedDataDescriptor: true }).unzip(() => ({
            handler: async data => {
              assert.equal(data.length, 100);
              delivered = true;
            }
          }));
          assert.fail('Expected truncated descriptor failure');
        } catch (error) {
          assert.equal((error as Error).name, 'EndOfStreamError');
        } finally {
          await tokenizer.close();
        }
        assert.isTrue(delivered);
      });
    }

    it('keeps truncated descriptor processing strict by default', async () => {
      const zip = makeZip(new Uint8Array(100).fill(1), true).subarray(0, 134);
      let called = false;
      try {
        await new ZipHandler(await stream(zip)).unzip(() => ({
          handler: async () => {
            called = true;
          }
        }));
        assert.fail('Expected truncated descriptor failure');
      } catch (error) {
        assert.match((error as Error).message, /data-descriptor-signature/);
      }
      assert.isFalse(called);
    });
  });

  describe('Traversal limit options', () => {
    for (const limit of [
      'maxEntryCount',
      'maxTotalScanBytes',
      'maxTotalDataDescriptorScanBytes',
      'maxSkippedEntrySize'
    ] as const) {
      it(`validates ${limit}`, () => {
        for (const value of [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
          assert.throws(() => new ZipHandler(fromBuffer(new Uint8Array()), { [limit]: value }), RangeError);
        }
        for (const value of [1, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY]) {
          assert.doesNotThrow(() => new ZipHandler(fromBuffer(new Uint8Array()), { [limit]: value }));
        }
      });
    }
  });

  describe('Per-entry limit option validation', () => {
    for (const limit of ['maxDataDescriptorScanBytes', 'maxCompressedSize', 'maxUncompressedSize'] as const) {
      it(`validates ${limit}`, () => {
        for (const value of [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
          assert.throws(() => new ZipHandler(fromBuffer(new Uint8Array()), { [limit]: value }), RangeError);
        }
        for (const value of [1, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY]) {
          assert.doesNotThrow(() => new ZipHandler(fromBuffer(new Uint8Array()), { [limit]: value }));
        }
      });
    }
  });

  describe('Unknown-size entries and data descriptor scanning', () => {
    for (const selected of [true, false]) {
      it(`bounds descriptor scanning for ${selected ? 'selected' : 'ignored'} entries`, async () => {
        const tokenizer = await stream(makeZip(new Uint8Array(101), true));
        await expectLimit(
          extract(tokenizer, { maxDataDescriptorScanBytes: 100 }, selected),
          'maxDataDescriptorScanBytes',
          100
        );
        assert.equal(tokenizer.position, 30, 'reject before consuming or retaining entry data');
      });
    }

    it('bounds unknown compressed buffering before reading the chunk', async () => {
      const tokenizer = await stream(makeZip(new Uint8Array(101), true));
      await expectLimit(extract(tokenizer, { maxCompressedSize: 100 }), 'maxCompressedSize', 100);
      assert.equal(tokenizer.position, 30);
    });

    it('bounds unknown stored output before buffering', async () => {
      await expectLimit(
        extract(await stream(makeZip(new Uint8Array(101), true)), { maxUncompressedSize: 100 }),
        'maxUncompressedSize',
        100
      );
    });

    for (const length of [100, chunkSize - 3, chunkSize - 2, chunkSize - 1, chunkSize, chunkSize + 10]) {
      it(`accepts exact scan, compressed-size and output limits of ${length} bytes`, async () => {
        const data = new Uint8Array(length).fill(1);
        const files = await extract(await stream(makeZip(data, true)), {
          maxDataDescriptorScanBytes: length,
          maxCompressedSize: length,
          maxUncompressedSize: length
        });
        assert.deepEqual(files, [data]);
      });
    }

    it('rejects oversized cumulative scan and buffering across chunks', async () => {
      for (const limit of ['maxDataDescriptorScanBytes', 'maxCompressedSize'] as const) {
        const tokenizer = await stream(makeZip(new Uint8Array(chunkSize + 20), true));
        await expectLimit(extract(tokenizer, { [limit]: chunkSize + 10 }), limit, chunkSize + 10);
        assert.isBelow(tokenizer.position, 30 + chunkSize + 20);
      }
    });

    it('bounds scans when the descriptor is missing', async () => {
      await expectLimit(
        extract(await stream(makeZip(new Uint8Array(1000), true).subarray(0, 500)), {
          maxDataDescriptorScanBytes: 100
        }),
        'maxDataDescriptorScanBytes',
        100
      );
    });

    it('supports bounded descriptor processing with a web byte stream', async () => {
      const zip = makeZip(new Uint8Array(100), true);
      const tokenizer = fromWebStream(
        new ReadableStream({
          type: 'bytes',
          start(controller) {
            controller.enqueue(zip);
            controller.close();
          }
        })
      );
      assert.lengthOf(await extract(tokenizer, { maxDataDescriptorScanBytes: 100, maxCompressedSize: 100 }), 1);
    });
  });

  describe('Known-size entries from local headers and central directories', () => {
    for (const central of [false, true]) {
      for (const limit of ['maxCompressedSize', 'maxUncompressedSize'] as const) {
        it(`checks ${limit} before reading a known-size ${central ? 'central-directory' : 'local-header'} entry`, async () => {
          const zip = makeZip(new Uint8Array(101), false, false, central);
          const tokenizer = central ? fromBuffer(zip) : await stream(zip);
          await expectLimit(extract(tokenizer, { [limit]: 100 }), limit, 100);
          assert.equal(tokenizer.position, central ? 0 : 30, 'directory traversal restores the borrowed cursor');
        });
      }
      it(`checks actual deflated output despite an understated ${central ? 'central' : 'local'} size`, async () => {
        const zip = makeZip(new Uint8Array(100000), false, true, central, 1);
        await expectLimit(
          extract(central ? fromBuffer(zip) : await stream(zip), { maxUncompressedSize: 100 }),
          'maxUncompressedSize',
          100
        );
      });
    }

    it('does not apply buffering/output limits to ignored known-size entries', async () => {
      assert.isEmpty(
        await extract(
          await stream(makeZip(new Uint8Array(100))),
          {
            maxCompressedSize: 1,
            maxUncompressedSize: 1
          },
          false
        )
      );
    });

    it('checks stored size despite an understated uncompressed header', async () => {
      await expectLimit(
        extract(await stream(makeZip(new Uint8Array(101), false, false, false, 1)), {
          maxUncompressedSize: 100
        }),
        'maxUncompressedSize',
        100
      );
    });

    it('accepts exact limits on known-size local and central-directory entries', async () => {
      const data = new Uint8Array(100);
      for (const central of [false, true]) {
        const zip = makeZip(data, false, false, central);
        assert.deepEqual(
          await extract(central ? fromBuffer(zip) : await stream(zip), {
            maxCompressedSize: 100,
            maxUncompressedSize: 100
          }),
          [data]
        );
      }
    });
  });

  describe('Deflate output limits and error handling', () => {
    it('recovers bounded output when descriptor bytes follow the deflate stream', async () => {
      const data = new Uint8Array(100000).fill(1);
      const zip = makeZipWithTrailingDeflateData(data);
      assert.deepEqual(await extract(await stream(zip), { maxUncompressedSize: data.length }), [data]);
    });

    it('does not recover oversized output when descriptor bytes follow the deflate stream', async () => {
      const zip = makeZipWithTrailingDeflateData(new Uint8Array(100000));
      // Understate the header so the actual inflated output must enforce the limit.
      new DataView(zip.buffer).setUint32(22, 1, true);
      await expectLimit(extract(await stream(zip), { maxUncompressedSize: 100 }), 'maxUncompressedSize', 100);
    });

    it('checks actual output for unknown-size deflated entries', async () => {
      await expectLimit(
        extract(await stream(makeZip(new Uint8Array(100000), true, true)), { maxUncompressedSize: 100 }),
        'maxUncompressedSize',
        100
      );
    });

    it('accepts exact deflated output limits, explicit infinity and unlimited defaults', async () => {
      const data = new Uint8Array(100000);
      for (const options of [
        {},
        { maxUncompressedSize: Number.POSITIVE_INFINITY },
        { maxUncompressedSize: data.length }
      ]) {
        assert.deepEqual(await extract(await stream(makeZip(data, true, true)), options), [data]);
      }
    });

    it('retains ZIP error context for malformed deflate data', async () => {
      const zip = makeZip(new Uint8Array([255, 255, 255]));
      new DataView(zip.buffer).setUint16(8, 8, true);
      try {
        await extract(await stream(zip));
        assert.fail('Expected malformed deflate failure');
      } catch (err) {
        assert.instanceOf(err, TypeError);
        assert.match((err as Error).message, /Failed to deflate ZIP entry/);
      }
    });

    it('cancels decompression and does not deliver a rejected entry', async () => {
      const original = globalThis.DecompressionStream;
      let canceled: unknown;
      let called = false;
      globalThis.DecompressionStream = class {
        readable = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(60));
            controller.enqueue(new Uint8Array(60));
          },
          cancel(reason) {
            canceled = reason;
          }
        });
        writable = new WritableStream<Uint8Array>();
      } as unknown as typeof DecompressionStream;
      const tokenizer = await stream(makeZip(new Uint8Array(1), false, true));
      try {
        await expectLimit(
          new ZipHandler(tokenizer, { maxUncompressedSize: 100 }).unzip(() => ({
            handler: async () => {
              called = true;
            }
          })),
          'maxUncompressedSize',
          100
        );
        assert.instanceOf(canceled, ZipLimitError);
        assert.isFalse(called);
      } finally {
        globalThis.DecompressionStream = original;
        await tokenizer.close();
      }
    });
  });

  describe('Per-entry limit accounting', () => {
    it('resets limits for each entry', async () => {
      const entry = makeZip(new Uint8Array(100), true).subarray(0, 146);
      const zip = new Uint8Array(entry.length * 2 + 4);
      zip.set(entry);
      zip.set(entry, entry.length);
      new DataView(zip.buffer).setUint32(entry.length * 2, 0x02014b50, true);
      assert.lengthOf(
        await extract(await stream(zip), {
          maxDataDescriptorScanBytes: 100,
          maxCompressedSize: 100,
          maxUncompressedSize: 100
        }),
        2
      );
    });
  });

  describe('Central-directory boundaries and source cursor preservation', () => {
    it('restores the source when a nested directory view cannot be created', async () => {
      const zip = makeCentralDirectoryZip();
      new DataView(zip.buffer).setUint32(79 + 12, zip.length, true);
      const source = fromBuffer(zip);
      const tokenizer = createTokenizerView(source, zip.length);
      await tokenizer.ignore(2);
      try {
        await new ZipHandler(tokenizer).readCentralDirectory();
        assert.fail('Expected directory view boundary error');
      } catch (error) {
        assert.instanceOf(error, TokenizerBoundaryError);
        assert.equal(tokenizer.position, 2);
      } finally {
        await tokenizer.close();
        await source.close();
      }
    });
    it('accepts an entry ending exactly at the directory boundary and preserves the source cursor', async () => {
      const tokenizer = fromBuffer(makeCentralDirectoryZip());
      await tokenizer.ignore(2);
      try {
        const files = await new ZipHandler(tokenizer).readCentralDirectory();
        assert.equal(files?.length, 1);
        assert.equal(files?.[0].filename, 'a');
        assert.equal(tokenizer.position, 2);
        assert.equal(await tokenizer.readToken(UINT8), 3, 'the borrowed source remains usable');
      } finally {
        await tokenizer.close();
      }
    });

    for (const [field, size] of [
      ['fixed header', 45],
      ['filename', 46],
      ['extra field', 47],
      ['comment', 48]
    ] as const) {
      it(`rejects ${field} data crossing the declared directory boundary`, async () => {
        const zip = makeCentralDirectoryZip();
        new DataView(zip.buffer).setUint32(79 + 12, size, true);
        const tokenizer = fromBuffer(zip);
        await tokenizer.ignore(2);
        try {
          try {
            await new ZipHandler(tokenizer).readCentralDirectory();
            assert.fail('Expected directory boundary error');
          } catch (error) {
            assert.instanceOf(error, TokenizerBoundaryError);
            assert.equal((error as TokenizerBoundaryError).size, size);
          }
          assert.equal(tokenizer.position, 2, 'restore the cursor after a parsing failure');
          assert.equal(await tokenizer.readToken(UINT8), 3);
        } finally {
          await tokenizer.close();
        }
      });
    }

    it('rejects an entry count extending beyond the declared directory', async () => {
      const zip = makeCentralDirectoryZip();
      new DataView(zip.buffer).setUint16(79 + 10, 2, true);
      const tokenizer = fromBuffer(zip);
      try {
        try {
          await new ZipHandler(tokenizer).readCentralDirectory();
          assert.fail('Expected directory boundary error');
        } catch (error) {
          assert.instanceOf(error, TokenizerBoundaryError);
          assert.equal((error as TokenizerBoundaryError).position, 49);
        }
        assert.equal(tokenizer.position, 0);
      } finally {
        await tokenizer.close();
      }
    });

    it('preserves the source cursor when no directory is found', async () => {
      const tokenizer = fromBuffer(new Uint8Array(30));
      await tokenizer.ignore(2);
      try {
        assert.isUndefined(await new ZipHandler(tokenizer).readCentralDirectory());
        assert.equal(tokenizer.position, 2);
      } finally {
        await tokenizer.close();
      }
    });
  });
});

describe('GzipHandler', () => {
  async function isTarGz(tokenizer: ITokenizer): Promise<boolean> {
    const handler = new GzipHandler(tokenizer);

    const stream = handler.inflate();
    try {
      const dataTokenizer = fromWebStream(stream);
      try {
        return await isTarHeaderChecksumMatches(dataTokenizer);
      } finally {
        await dataTokenizer.close();
      }
    } finally {
      await stream.cancel();
    }
    return false;
  }

  it('Inflate gunzip file', async () => {
    const tokenizer = await makeFileTokenizer('simple.txt.gz');
    try {
      const gzipHandler = new GzipHandler(tokenizer);
      const readableStream = gzipHandler.inflate();
      const reader = readableStream.getReader();
      try {
        let decodedResult = await reader.read();
        assert.strictEqual(decodedResult.done, false, 'decodedResult.done');
        const decodedText = new TextDecoder('ascii').decode(decodedResult.value);
        assert.strictEqual(
          decodedText,
          'Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n' +
            'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n',
          'decoded text'
        );
        decodedResult = await reader.read();
        assert.strictEqual(decodedResult.done, true, 'decodedResult.done');
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    } finally {
      await tokenizer.close();
    }
  });

  it('Inflate partial file', async () => {
    const buf = Uint8Array.from([31, 139, 8, 8, 137, 83, 29, 82, 0, 11]);
    const tokenizer = fromBuffer(buf);

    try {
      const gzipHandler = new GzipHandler(tokenizer);
      const reader = gzipHandler.inflate().getReader();

      let threw = false;
      try {
        await reader.read();
      } catch (err) {
        threw = true;

        // Biome-friendly: treat err as unknown
        const e = err as unknown;

        if (!(e instanceof Error)) {
          throw new Error(`Expected a decompression Error, got: ${String(e)}`);
        }

        // no message assertions (Node 20 sometimes returns an empty message)
        assert.instanceOf(e, Error, 'expected a decompression error');
      }

      assert.isTrue(threw, 'expected reader.read() to throw for partial gzip');
    } finally {
      await tokenizer.close();
    }
  });

  it('Inflate small tar.gz file', async () => {
    const tokenizer = await makeFileTokenizer('fixture-gnu.tgz');
    try {
      assert.isTrue(await isTarGz(tokenizer));
    } finally {
      await tokenizer.close();
    }
  });

  it('Inflate large tar.gz file', async function () {
    this.timeout(15000); // Increase timeout
    const result = await fetch('https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.7.12.tar.gz');
    assert.ok(result.ok, 'HTTP request is ok');
    if (result.body !== null) {
      const tokenizer = fromWebStream(result.body);
      try {
        assert.isTrue(await isTarGz(tokenizer));
      } finally {
        try {
          await tokenizer.close();
        } finally {
          await result.body.cancel();
        }
      }
    } else {
      assert.fail('Could not stream HTTP result');
    }
  });
});
