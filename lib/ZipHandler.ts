import type { IRandomAccessTokenizer, ITokenizer } from 'strtok3';
import { StringType, UINT32_LE } from 'token-types';
import { decompressSync } from 'fflate';
import initDebug from 'debug';
import {
  DataDescriptor,
  EndOfCentralDirectoryRecordToken,
  FileHeader,
  type IFileHeader,
  type ILocalFileHeader,
  LocalFileHeaderToken, Signature
} from "./ZipToken.js";

export type InflateFileFilterResult = {
  handler: InflatedDataHandler | false; // Function to handle extracted file data
  stop?: boolean;               // Signal to stop processing further files
};

export type { ILocalFileHeader } from './ZipToken.js';

function signatureToArray(signature: number): Uint8Array {
  const signatureBytes = new Uint8Array(UINT32_LE.len);
  UINT32_LE.put(signatureBytes, 0, signature);
  return signatureBytes;
}

const debug = initDebug('tokenizer:inflate');

const syncBufferSize = 256 * 1024;

const ddSignatureArray = signatureToArray(Signature.DataDescriptor);
const eocdSignatureBytes = signatureToArray(Signature.EndOfCentralDirectory);

/**
 * Return false when to ignore the file, return `InflatedDataHandler` to handle extracted data
 */
export type InflateFileFilter = (file: ILocalFileHeader) => InflateFileFilterResult;

export type InflatedDataHandler = (fileData: Uint8Array) => Promise<void>;

export class ZipHandler {

  private syncBuffer = new Uint8Array(syncBufferSize);

  constructor(private tokenizer: ITokenizer) {
  }

  async isZip(): Promise<boolean> {
    return await this.peekSignature() === Signature.LocalFileHeader;
  }

  private peekSignature(): Promise<number> {
    return this.tokenizer.peekToken(UINT32_LE);
  }

  async findEndOfCentralDirectoryLocator(): Promise<number> {
    const randomReadTokenizer = this.tokenizer as IRandomAccessTokenizer;
    const chunkLength = Math.min(16 * 1024, randomReadTokenizer.fileInfo.size);
    const buffer = this.syncBuffer.subarray(0, chunkLength);
    await this.tokenizer.readBuffer(buffer, {position: randomReadTokenizer.fileInfo.size - chunkLength});
    // Search the buffer from end to beginning for EOCD signature
    // const signature = 0x06054b50;
    for (let i = buffer.length - 4; i >= 0; i--) {
      // Compare 4 bytes directly without calling readUInt32LE
      if (
        buffer[i] === eocdSignatureBytes[0] &&
        buffer[i + 1] === eocdSignatureBytes[1] &&
        buffer[i + 2] === eocdSignatureBytes[2] &&
        buffer[i + 3] === eocdSignatureBytes[3]
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
      const files: IFileHeader[] = [];
      (this.tokenizer as IRandomAccessTokenizer).setPosition(eocdHeader.offsetOfStartOfCd);
      for (let n = 0; n < eocdHeader.nrOfEntriesOfSize; ++n) {
        const entry = await this.tokenizer.readToken(FileHeader);
        if (entry.signature !== Signature.CentralFileHeader) {
          throw new Error('Expected Central-File-Header signature');
        }
        entry.filename = await this.tokenizer.readToken(new StringType(entry.filenameLength, 'utf-8'));
        await this.tokenizer.ignore(entry.extraFieldLength);
        await this.tokenizer.ignore(entry.fileCommentLength);
        files.push(entry);
        debug(`Add central-directory file-entry: n=${n + 1}/${files.length}: filename=${files[n].filename}`);
      }
      (this.tokenizer as IRandomAccessTokenizer).setPosition(pos);
      return files;
    }
    (this.tokenizer as IRandomAccessTokenizer).setPosition(pos);
  }

  async unzip(fileCb: InflateFileFilter): Promise<void> {
    const entries = await this.readCentralDirectory();
    if (entries) {
      // Use Central Directory to iterate over files
      return this.iterateOverCentralDirectory(entries, fileCb);
    }

    // Scan Zip files for local-file-header
    let stop = false;
    do {
      const zipHeader = await this.readLocalFileHeader();
      if (!zipHeader)
        break;

      const next = fileCb(zipHeader);
      stop = !!next.stop;

      let fileData: Uint8Array | undefined ;

      await this.tokenizer.ignore(zipHeader.extraFieldLength);

      if (zipHeader.dataDescriptor && zipHeader.compressedSize === 0) {
        const chunks: Uint8Array[] = [];
        let len = syncBufferSize;

        debug('Compressed-file-size unknown, scanning for next data-descriptor-signature....');
        let nextHeaderIndex = -1;
        while (nextHeaderIndex < 0 && len === syncBufferSize) {

          len = await this.tokenizer.peekBuffer(this.syncBuffer, {mayBeLess: true});
          nextHeaderIndex = indexOf(this.syncBuffer.subarray(0, len), ddSignatureArray);
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
        debug(`Found data-descriptor-signature at pos=${this.tokenizer.position}`);
        if (next.handler) {
          await this.inflate(zipHeader, mergeArrays(chunks), next.handler);
        }
      } else {
        if (next.handler) {
          debug(`Reading compressed-file-data: ${zipHeader.compressedSize} bytes`);
          fileData = new Uint8Array(zipHeader.compressedSize);
          await this.tokenizer.readBuffer(fileData);
          await this.inflate(zipHeader, fileData, next.handler as InflatedDataHandler);
        } else {
          debug(`Ignoring compressed-file-data: ${zipHeader.compressedSize} bytes`);
          await this.tokenizer.ignore(zipHeader.compressedSize);
        }
      }

      debug(`Reading data-descriptor at pos=${this.tokenizer.position}`);
      if (zipHeader.dataDescriptor) {
        // await this.tokenizer.ignore(DataDescriptor.len);
        const dataDescriptor = await this.tokenizer.readToken(DataDescriptor);
        if (dataDescriptor.signature !== 0x08074b50) {
          throw new Error(`Expected data-descriptor-signature at position ${this.tokenizer.position - DataDescriptor.len}`);
        }
      }
    } while (!stop);
  }

  private async iterateOverCentralDirectory(entries: IFileHeader[], fileCb: InflateFileFilter) {
    for (const fileHeader of entries) {
      const next = fileCb(fileHeader);
      if (next.handler) {
        (this.tokenizer as IRandomAccessTokenizer).setPosition(fileHeader.relativeOffsetOfLocalHeader);
        const zipHeader = await this.readLocalFileHeader();
        if (zipHeader) {
          await this.tokenizer.ignore(zipHeader.extraFieldLength);
          const fileData = new Uint8Array(fileHeader.compressedSize);
          await this.tokenizer.readBuffer(fileData);
          await this.inflate(zipHeader, fileData, next.handler);
        }
      }
      if (next.stop) break;
    }
  }

  private inflate(zipHeader: ILocalFileHeader, fileData: Uint8Array, cb: InflatedDataHandler): Promise<void> {
    if (zipHeader.compressedMethod === 0) {
      return cb(fileData);
    }
    debug(`Decompress filename=${zipHeader.filename}, compressed-size=${fileData.length}`);
    const uncompressedData = decompressSync(fileData);
    return cb(uncompressedData);
  }

  private async readLocalFileHeader(): Promise<ILocalFileHeader | false> {
    const signature = await this.tokenizer.peekToken(UINT32_LE);
    if (signature === Signature.LocalFileHeader) {
      const header = await this.tokenizer.readToken(LocalFileHeaderToken);
      header.filename = await this.tokenizer.readToken(new StringType(header.filenameLength, 'utf-8'));
      return header;
    }
    if (signature === Signature.CentralFileHeader) {
      return false;
    }
    if (signature === 0xE011CFD0) {
      throw new Error('Encrypted ZIP');
    }
    throw new Error('Unexpected signature');
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