/**
 * Ref https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 */

import {EndOfStreamError, type IGetToken, type IRandomAccessTokenizer, type ITokenizer} from "strtok3";
import {StringType, UINT16_LE, UINT32_LE} from "token-types";
import {decompressSync} from "fflate";
import initDebug from 'debug';

const debug = initDebug('tokenizer:inflate');

const syncBufferSize = 256 * 1024;

const headerPrefix = [0x50, 0x4B, 0x3, 0x4];

const lenDataDescriptor = 12;

export type InflateFileFilterResult = {
  handler: InflatedDataHandler | false; // Function to handle extracted file data
  stop?: boolean;               // Signal to stop processing further files
};

/**
 * Return false when to ignore the file, return `InflatedDataHandler` to handle extracted data
 */
export type InflateFileFilter = (file: ILocalFileHeader) => InflateFileFilterResult;

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
  filename: string;
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
const LocalFileHeaderToken: IGetToken<ILocalFileHeader> = {
  get(array: Uint8Array): ILocalFileHeader {
    const flags = UINT16_LE.get(array, 6)
    return {
      minVersion: UINT16_LE.get(array, 4),
      dataDescriptor: !!(flags & 0x0008),
      compressedMethod: UINT16_LE.get(array, 8),
      compressedSize: UINT32_LE.get(array, 18),
      uncompressedSize: UINT32_LE.get(array, 22),
      filenameLength: UINT16_LE.get(array, 26),
      extraFieldLength: UINT16_LE.get(array, 28),
      filename: null as unknown as string
    }
  }, len: 30
}

interface I64EndOfCentralDirectoryRecord {
  signature: number,
  directoryRecord: bigint,
  versionMadeBy: number,
  versionNeedToExtract: number,
  nrOfThisDisk: number,
  nrOfThisDiskWithTheStart: number,
  nrOfEntriesOnThisDisk: bigint,
  nrOfEntriesOfSize: bigint,
  offsetOfStartOfCd: bigint,
}

interface IEndOfCentralDirectoryRecord {
  signature: number,
  nrOfThisDisk: number,
  nrOfThisDiskWithTheStart: number,
  nrOfEntriesOnThisDisk: number,
  nrOfEntriesOfSize: number,
  sizeOfCd: number,
  offsetOfStartOfCd: number,
  zipFileCommentLength: number,
}

/**
 * 4.3.16  End of central directory record:
 *  end of central dir signature (0x06064b50)                                      4 bytes
 *  number of this disk                                                            2 bytes
 *  number of the disk with the start of the central directory                     2 bytes
 *  total number of entries in the central directory on this disk                  2 bytes
 *  total number of entries in the size of the central directory                   2 bytes
 *  sizeOfTheCentralDirectory                                                      4 bytes
 *  offset of start of central directory with respect to the starting disk number  4 bytes
 *  .ZIP file comment length                                                       2 bytes
 *  .ZIP file comment       (variable size)
 */
const EndOfCentralDirectoryRecordToken: IGetToken<IEndOfCentralDirectoryRecord> = {
  get(array: Uint8Array): IEndOfCentralDirectoryRecord {
    return {
      signature: UINT32_LE.get(array, 0),
      nrOfThisDisk: UINT16_LE.get(array, 4),
      nrOfThisDiskWithTheStart: UINT16_LE.get(array, 6),
      nrOfEntriesOnThisDisk: UINT16_LE.get(array, 8),
      nrOfEntriesOfSize: UINT16_LE.get(array, 10),
      sizeOfCd: UINT32_LE.get(array, 12),
      offsetOfStartOfCd: UINT32_LE.get(array, 16),
      zipFileCommentLength: UINT16_LE.get(array, 20),
    }
  }, len: 22
}

interface IFileHeader extends ILocalFileHeader {
  fileCommentLength: number;
  relativeOffsetOfLocalHeader: number;
}

/**
 * File header:
 *    central file header signature   4 bytes   0 (0x02014b50)
 *    version made by                 2 bytes   4
 *    version needed to extract       2 bytes   6
 *    general purpose bit flag        2 bytes   8
 *    compression method              2 bytes  10
 *    last mod file time              2 bytes  12
 *    last mod file date              2 bytes  14
 *    crc-32                          4 bytes  16
 *    compressed size                 4 bytes  20
 *    uncompressed size               4 bytes  24
 *    file name length                2 bytes  28
 *    extra field length              2 bytes  30
 *    file comment length             2 bytes  32
 *    disk number start               2 bytes  34
 *    internal file attributes        2 bytes  36
 *    external file attributes        4 bytes  38
 *    relative offset of local header 4 bytes  42
 */
const FileHeader: IGetToken<IFileHeader> = {
  get(array: Uint8Array): IFileHeader {
    const flags = UINT16_LE.get(array, 8)

    return {
      minVersion: UINT16_LE.get(array, 6),
      dataDescriptor: !!(flags & 0x0008),
      compressedMethod: UINT16_LE.get(array, 10),
      compressedSize: UINT32_LE.get(array, 20),
      uncompressedSize: UINT32_LE.get(array, 24),
      filenameLength: UINT16_LE.get(array, 28),
      extraFieldLength: UINT16_LE.get(array, 30),

      fileCommentLength: UINT16_LE.get(array, 32),
      relativeOffsetOfLocalHeader: UINT32_LE.get(array, 42),
      filename: null as unknown as string
    }
  }, len: 46
}

export class ZipHandler {

  private syncBuffer = new Uint8Array(syncBufferSize);

  private entries: IFileHeader[] | undefined;

  constructor(private tokenizer: ITokenizer) {
  }

  async isZip(): Promise<boolean> {
    const magicPrefix = new Uint8Array(4);
    const len = await this.tokenizer.peekBuffer(magicPrefix, {mayBeLess: true});
    return len === 4 && headerPrefix.every((v, i) => magicPrefix[i] === v);
  }

  async findEndOfCentralDirectoryLocator(): Promise<number> {
    const randomReadTokenizer = this.tokenizer as IRandomAccessTokenizer;
    const chunkLength = Math.min(16 * 1024, randomReadTokenizer.fileInfo.size);
    const buffer = this.syncBuffer.subarray(0, chunkLength);
    await this.tokenizer.readBuffer(buffer, {position: randomReadTokenizer.fileInfo.size - chunkLength});
    // Search the buffer from end to beginning for EOCD signature
    // const signature = 0x06054b50;
    const signatureBytes = new Uint8Array([0x50, 0x4b, 0x05, 0x06]); // EOCD signature bytes
    for (let i = buffer.length - 4; i >= 0; i--) {
      // Compare 4 bytes directly without calling readUInt32LE
      if (
        buffer[i] === signatureBytes[0] &&
        buffer[i + 1] === signatureBytes[1] &&
        buffer[i + 2] === signatureBytes[2] &&
        buffer[i + 3] === signatureBytes[3]
      ) {
        return randomReadTokenizer.fileInfo.size - chunkLength + i;
      }
    }
    return -1;
  }

  async readCentralDirectory(): Promise<IFileHeader[] | undefined> {
    if (!this.tokenizer.supportsRandomAccess()) {
      debug('Cannot reading central-directory without random-read support');
      return;
    }
    debug('Reading central-directory...');
    const pos = this.tokenizer.position;
    const offset = await this.findEndOfCentralDirectoryLocator();
    if (offset > 0) {
      debug('Central-directory 32-bit signature found');
      const eocdHeader = await this.tokenizer.readToken(EndOfCentralDirectoryRecordToken, offset);
      const files: IFileHeader[] = new Array(eocdHeader.nrOfEntriesOfSize);
      (this.tokenizer as IRandomAccessTokenizer).setPosition(eocdHeader.offsetOfStartOfCd)
      for(let n=0; n<files.length; ++n) {
        const entry = await this.tokenizer.readToken(FileHeader);
        entry.filename = await this.tokenizer.readToken(new StringType(entry.filenameLength, 'utf-8'));
        files[n] = entry;
        debug(`Add central-directory file-entry: n=${n}/${files.length}: filename=${ files[n].filename}`);
      }
      (this.tokenizer as IRandomAccessTokenizer).setPosition(pos);
      return files;
    }
    (this.tokenizer as IRandomAccessTokenizer).setPosition(pos);
  }

  async unzip(fileCb: InflateFileFilter): Promise<void> {

   if (!await this.isZip()) {
      throw new Error('This is not a Zip archive');
    }

    let entry = 0;

    let stop = false;
    do {
      let zipHeader: ILocalFileHeader;
      if (this.entries) {
        // Use Central Director entry
        zipHeader = this.entries[entry];
        await this.tokenizer.ignore(LocalFileHeaderToken.len + zipHeader.filenameLength);
      } else {
        try {
          zipHeader = await this.tokenizer.readToken(LocalFileHeaderToken);
        } catch (error) {
          if (error instanceof EndOfStreamError) break;
          throw error;
        }
        zipHeader.filename = await this.tokenizer.readToken(new StringType(zipHeader.filenameLength, 'utf-8'));
      }
      const next = fileCb(zipHeader);
      stop = !!next.stop;

      let fileData: Uint8Array | undefined = undefined;

      await this.tokenizer.ignore(zipHeader.extraFieldLength);

      if (entry === 0 && zipHeader.dataDescriptor) {

        this.entries = await this.readCentralDirectory();
        if (this.entries) {
          zipHeader = this.entries[entry];
        }
      }

      if (zipHeader.compressedSize === 0) {
        const chunks: Uint8Array[] = [];
        let len = syncBufferSize;
        const headerPrefixArray = new Uint8Array(headerPrefix)

        debug('Compressed-file-size unknown, scanning for next local-file-header');
        let nextHeaderIndex = -1;
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
        fileData = new Uint8Array(zipHeader.compressedSize);
        await this.tokenizer.readBuffer(fileData);
        // Set position to next ZIP header
        await this.tokenizer.ignore(lenDataDescriptor + 4); // Where Are these extra 4 bytes coming from ??
      }

      if (next.handler) {
        // Extract file data
        if(!fileData)
          throw new Error('fileData should be assigned');
        if (zipHeader.compressedMethod === 0) {
          await next.handler(fileData);
        } else {
          debug(   `Decompress filename=${zipHeader.filename}, compressed-size=${fileData.length}`);
          const uncompressedData = decompressSync(fileData);
          await next.handler(uncompressedData);
        }
      }
      ++entry;
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