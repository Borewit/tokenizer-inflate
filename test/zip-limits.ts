import { Readable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import { assert } from 'chai';
import { fromBuffer, fromStream, fromWebStream, type ITokenizer } from 'strtok3';
import { ZipHandler, type ZipHandlerOptions, ZipLimitError } from '../lib/index.js';

const chunkSize = 256 * 1024;

function makeZip(data: Uint8Array, descriptor = false, deflate = false, central = false, declaredSize = data.length) {
  const compressed = deflate ? deflateRawSync(data) : data;
  const header = new Uint8Array(30);
  const local = new DataView(header.buffer);
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(6, descriptor ? 8 : 0, true);
  local.setUint16(8, deflate ? 8 : 0, true);
  local.setUint32(18, descriptor ? 0 : compressed.length, true);
  local.setUint32(22, descriptor ? 0 : declaredSize, true);
  const trailer = new Uint8Array(descriptor ? 16 : 0);
  if (descriptor) {
    const dd = new DataView(trailer.buffer);
    dd.setUint32(0, 0x08074b50, true);
    dd.setUint32(8, compressed.length, true);
    dd.setUint32(12, data.length, true);
  }
  const directory = new Uint8Array(central ? 68 : 4);
  const cd = new DataView(directory.buffer);
  cd.setUint32(0, 0x02014b50, true);
  if (central) {
    cd.setUint16(10, deflate ? 8 : 0, true);
    cd.setUint32(20, compressed.length, true);
    cd.setUint32(24, declaredSize, true);
    cd.setUint32(46, 0x06054b50, true);
    cd.setUint16(54, 1, true);
    cd.setUint16(56, 1, true);
    cd.setUint32(58, 46, true);
    cd.setUint32(62, header.length + compressed.length + trailer.length, true);
  }
  const zip = new Uint8Array(header.length + compressed.length + trailer.length + directory.length);
  zip.set(header);
  zip.set(compressed, header.length);
  zip.set(trailer, header.length + compressed.length);
  zip.set(directory, header.length + compressed.length + trailer.length);
  return zip;
}

async function extract(tokenizer: ITokenizer, options: ZipHandlerOptions = {}, selected = true) {
  const files: Uint8Array[] = [];
  try {
    await new ZipHandler(tokenizer, options).unzip(() => ({
      handler: selected
        ? async data => {
            files.push(data);
          }
        : false
    }));
    return files;
  } finally {
    await tokenizer.close();
  }
}

async function expectLimit(work: Promise<unknown>, limit: keyof ZipHandlerOptions, maxSize: number) {
  try {
    await work;
    assert.fail('Expected ZIP limit error');
  } catch (err) {
    assert.instanceOf(err, ZipLimitError);
    const error = err as ZipLimitError;
    assert.equal(error.name, 'ZipLimitError');
    assert.equal(error.limit, limit);
    assert.equal(error.maxSize, maxSize);
    assert.isAbove(error.requestedSize, maxSize);
  }
}

async function stream(zip: Uint8Array) {
  return fromStream(Readable.from([zip], { objectMode: false }));
}

describe('Opt-in ZIP processing limits', () => {
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
    it(`accepts an exact scan/buffer/output boundary of ${length}, including split signatures`, async () => {
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
      extract(await stream(makeZip(new Uint8Array(1000), true).subarray(0, 500)), { maxDataDescriptorScanBytes: 100 }),
      'maxDataDescriptorScanBytes',
      100
    );
  });

  for (const central of [false, true]) {
    for (const limit of ['maxCompressedSize', 'maxUncompressedSize'] as const) {
      it(`checks ${limit} before reading a known-size ${central ? 'central-directory' : 'local-header'} entry`, async () => {
        const zip = makeZip(new Uint8Array(101), false, false, central);
        const tokenizer = central ? fromBuffer(zip) : await stream(zip);
        await expectLimit(extract(tokenizer, { [limit]: 100 }), limit, 100);
        assert.equal(tokenizer.position, 30);
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

  it('checks actual output for unknown-size deflated entries', async () => {
    await expectLimit(
      extract(await stream(makeZip(new Uint8Array(100000), true, true)), { maxUncompressedSize: 100 }),
      'maxUncompressedSize',
      100
    );
  });

  it('allows exact deflated output limits and unlimited defaults', async () => {
    const data = new Uint8Array(100000);
    for (const options of [
      {},
      { maxUncompressedSize: Number.POSITIVE_INFINITY },
      { maxUncompressedSize: data.length }
    ]) {
      assert.deepEqual(await extract(await stream(makeZip(data, true, true)), options), [data]);
    }
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
