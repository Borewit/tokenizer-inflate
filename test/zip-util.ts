import { Readable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import { assert } from 'chai';
import { fromStream, type ITokenizer } from 'strtok3';
import { ZipHandler, type ZipHandlerOptions, ZipLimitError } from '../lib/index.js';

export function makeZip(
  data: Uint8Array,
  descriptor = false,
  deflate = false,
  central = false,
  declaredSize = data.length
) {
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

export async function extract(tokenizer: ITokenizer, options: ZipHandlerOptions = {}, selected = true) {
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

export async function expectLimit(work: Promise<unknown>, limit: keyof ZipHandlerOptions, maxSize: number) {
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

export async function stream(zip: Uint8Array) {
  return fromStream(Readable.from([zip], { objectMode: false }));
}

export function makeZipWithTrailingDeflateData(data: Uint8Array) {
  const zip = makeZip(data, false, true);
  const header = new DataView(zip.buffer);
  const compressedSize = header.getUint32(18, true);
  const descriptor = new Uint8Array(12);
  const view = new DataView(descriptor.buffer);
  view.setUint32(4, compressedSize, true);
  view.setUint32(8, data.length, true);
  const output = new Uint8Array(zip.length + descriptor.length);
  output.set(zip.subarray(0, 30 + compressedSize));
  output.set(descriptor, 30 + compressedSize);
  output.set(zip.subarray(30 + compressedSize), 30 + compressedSize + descriptor.length);
  // Exercise the inflater with descriptor bytes retained by an entry scanner.
  new DataView(output.buffer).setUint32(18, compressedSize + descriptor.length, true);
  return output;
}

// One local header followed by a central-directory entry and EOCD record.
export function makeCentralDirectoryZip() {
  const zip = new Uint8Array(30 + 46 + 3 + 22);
  const header = new DataView(zip.buffer);
  header.setUint32(0, 0x04034b50, true);
  header.setUint32(30, 0x02014b50, true);
  header.setUint16(30 + 28, 1, true); // filename
  header.setUint16(30 + 30, 1, true); // extra field
  header.setUint16(30 + 32, 1, true); // comment
  zip.set([97, 0, 98], 30 + 46);
  header.setUint32(79, 0x06054b50, true);
  header.setUint16(79 + 8, 1, true);
  header.setUint16(79 + 10, 1, true);
  header.setUint32(79 + 12, 49, true);
  header.setUint32(79 + 16, 30, true);
  return zip;
}

export function makeRepeatedZip(count: number, size: number, descriptor = false, central = false): Uint8Array {
  const entry = makeZip(new Uint8Array(size).fill(1), descriptor).subarray(0, 30 + size + (descriptor ? 16 : 0));
  const dataLength = entry.length * count;
  const zip = new Uint8Array(dataLength + (central ? 46 * count + 22 : 4));
  const view = new DataView(zip.buffer);
  for (let index = 0; index < count; index++) {
    zip.set(entry, index * entry.length);
    if (central) {
      const offset = dataLength + index * 46;
      view.setUint32(offset, 0x02014b50, true);
      view.setUint32(offset + 20, size, true);
      view.setUint32(offset + 24, size, true);
      view.setUint32(offset + 42, index * entry.length, true);
    }
  }
  if (central) {
    const offset = dataLength + count * 46;
    view.setUint32(offset, 0x06054b50, true);
    view.setUint16(offset + 8, count, true);
    view.setUint16(offset + 10, count, true);
    view.setUint32(offset + 12, count * 46, true);
    view.setUint32(offset + 16, dataLength, true);
  } else {
    view.setUint32(dataLength, 0x02014b50, true);
  }
  return zip;
}
