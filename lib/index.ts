import {EndOfStreamError, type IGetToken, type ITokenizer} from "strtok3";
import {StringType} from "token-types";
import {decompressSync} from "fflate";

const syncBufferSize = 256 * 1024;

const headerPrefix = [0x50, 0x4B, 0x3, 0x4];

export type InflateFileFilterResult = {
  handler: InflatedDataHandler | false; // Function to handle extracted file data
  stop?: boolean;               // Signal to stop processing further files
};

/**
 * Return false when to ignore the file, return `InflatedDataHandler` to handle extracted data
 */
export type InflateFileFilter = (file: IFullZipHeader) => InflateFileFilterResult;

export type InflatedDataHandler = (fileData: Uint8Array) => Promise<void>;

interface IDataDescriptor {
  compressedSize: number;
  uncompressedSize: number;
}

interface ILocalFileHeader extends IDataDescriptor {
  minVersion: number;
  dataDescriptor: boolean;
  compressedMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  filenameLength: number;
  extraFieldLength: number;
}

interface IFullZipHeader extends ILocalFileHeader {
  filename?: string;
}

/**
 * First part of the ZIP Local File Header
 * Offset | Bytes| Description
 * -------|------+-------------------------------------------------------------------
 *      0 |    4 | Signature (0x04034b50)
 *      4 |    2 | Minimum version needed to extract
 *      6 |    2 | Bit flag
 *      8 |    2 | Compression method
 *     10 |    2 | File last modification time (MS-DOS format)
 *     12 |    2 | File last modification date (MS-DOS format)
 *     14 |    4 | CRC-32 of uncompressed data
 *     18 |    4 | Compressed size
 *     22 |    4 | Uncompressed size
 *     26 |    2 | File name length (n)
 *     28 |    2 | Extra field length (m)
 *     30 |    n | File name
 * 30 + n |    m | Extra field
 */
const ZipHeaderToken: IGetToken<ILocalFileHeader> = {
  get(array: Uint8Array): ILocalFileHeader {
    const view = new DataView(array.buffer);
    const flags = view.getUint16(6, true)
    return {
      minVersion: view.getUint16(4, true),
      dataDescriptor: !!(flags & 0x0008),
      compressedMethod: view.getUint16(8, true),
      compressedSize: view.getUint32(18, true),
      uncompressedSize: view.getUint32(22, true),
      filenameLength: view.getUint16(26, true),
      extraFieldLength: view.getUint16(28, true),
    }
  }, len: 30
}

export class ZipHandler {

  private syncBuffer = new Uint8Array(syncBufferSize);

  constructor(private tokenizer: ITokenizer) {
  }

  async isZip(): Promise<boolean> {
    const magicPrefix = new Uint8Array(4);
    const len = await this.tokenizer.peekBuffer(magicPrefix, {mayBeLess: true});
    return len === 4 && headerPrefix.every((v, i) => magicPrefix[i] === v);
  }

  async unzip(fileCb: InflateFileFilter): Promise<void> {

   if (!await this.isZip()) {
      throw new Error('This is not a Zip archive');
    }

    let stop = false;
    do {
      let zipHeader: IFullZipHeader;
      try {
        zipHeader = await this.tokenizer.readToken(ZipHeaderToken);
      } catch (error) {
        if (error instanceof EndOfStreamError) break;
        throw error;
      }
      zipHeader.filename = await this.tokenizer.readToken(new StringType(zipHeader.filenameLength, 'utf-8'));
      const next = fileCb(zipHeader);
      stop = !!next.stop;

      let fileData: Uint8Array | undefined = undefined;

      await this.tokenizer.ignore(zipHeader.extraFieldLength);

      if (zipHeader.dataDescriptor && zipHeader.compressedSize === 0) {
        const chunks: Uint8Array[] = [];
        let nextHeaderIndex = -1;
        let len = syncBufferSize;
        const headerPrefixArray = new Uint8Array(headerPrefix)

        while (nextHeaderIndex < 0 && len === syncBufferSize) {
          len = await this.tokenizer.peekBuffer(this.syncBuffer, {mayBeLess: true});

          nextHeaderIndex = indexOf(this.syncBuffer.subarray(0, len), headerPrefixArray);

          const size = nextHeaderIndex >= 0 ? nextHeaderIndex : len;

          if (next.handler) {
            const data = new Uint8Array(size);
            await this.tokenizer.readBuffer(data);
            chunks.push(data);
          } else {
            // Move position to the next header if found, skip the whole buffer otherwise
            await this.tokenizer.ignore(size);
          }
        }
        fileData = mergeArrays(chunks);
      } else {
        if (next.handler) {
          fileData = new Uint8Array(zipHeader.compressedSize);
          await this.tokenizer.readBuffer(fileData);
        } else {
          await this.tokenizer.ignore(zipHeader.compressedSize);
        }
      }
      if (next.handler) {
        // Extract file data
        if(!fileData)
          throw new Error('fileData should be assigned');
        if (zipHeader.compressedMethod === 0) {
          await next.handler(fileData);
        } else {
          const uncompressedData = decompressSync(fileData);
          await next.handler(uncompressedData);
        }
      }
    } while(!stop);
  }
}

function indexOf(buffer: Uint8Array, portion: Uint8Array): number {
  const bufferLength = buffer.length;
  const portionLength = portion.length;

  // Return -1 if the portion is longer than the buffer
  if (portionLength > bufferLength) return -1;

  // Search for the portion in the buffer
  for (let i = 0; i <= bufferLength - portionLength; i++) {
    let found = true;

    for (let j = 0; j < portionLength; j++) {
      if (buffer[i + j] !== portion[j]) {
        found = false;
        break;
      }
    }

    if (found) {
      return i; // Return the starting offset
    }
  }

  return -1; // Not found
}

function mergeArrays(chunks: Uint8Array[]) {
  // Concatenate chunks into a single Uint8Array
  const totalLength = chunks.reduce((acc, curr) => acc + curr.length, 0);
  const mergedArray = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    mergedArray.set(chunk, offset);
    offset += chunk.length;
  }
  return mergedArray;
}