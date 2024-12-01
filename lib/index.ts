import {EndOfStreamError, type IRandomAccessTokenizer, type ITokenizer} from 'strtok3';
import {StringType} from 'token-types';
import {decompressSync} from 'fflate';
import initDebug from 'debug';
import {
  DataDescriptor,
  EndOfCentralDirectoryRecordToken,
  FileHeader,
  type IFileHeader,
  type ILocalFileHeader,
  LocalFileHeaderToken
} from "./ZipToken.js";

const debug = initDebug('tokenizer:inflate');

const syncBufferSize = 256 * 1024;

/**
 * Local file header signature 0x04034b50
 * Ref: 4.3.7
 */
const SignatureLocalFileHeader = [0x50, 0x4B, 0x03, 0x04];
/**
 * Data descriptor record signature 0x08074b50
 * Ref: 4.3.9.3
 */
const SignatureDataDescriptor = [0x50, 0x4B, 0x07, 0x08];

export type InflateFileFilterResult = {
  handler: InflatedDataHandler | false; // Function to handle extracted file data
  stop?: boolean;               // Signal to stop processing further files
};

/**
 * Return false when to ignore the file, return `InflatedDataHandler` to handle extracted data
 */
export type InflateFileFilter = (file: ILocalFileHeader) => InflateFileFilterResult;

export type InflatedDataHandler = (fileData: Uint8Array) => Promise<void>;

export class ZipHandler {

  private syncBuffer = new Uint8Array(syncBufferSize);

  private entries: ILocalFileHeader[] | undefined;

  constructor(private tokenizer: ITokenizer) {
  }

  async isZip(): Promise<boolean> {
    const magicPrefix = new Uint8Array(4);
    const len = await this.tokenizer.peekBuffer(magicPrefix, {mayBeLess: true});
    return len === 4 && SignatureLocalFileHeader.every((v, i) => magicPrefix[i] === v);
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
      for (let n = 0; n < files.length; ++n) {
        const entry = await this.tokenizer.readToken(FileHeader);
        entry.filename = await this.tokenizer.readToken(new StringType(entry.filenameLength, 'utf-8'));
        files[n] = entry;
        debug(`Add central-directory file-entry: n=${n}/${files.length}: filename=${files[n].filename}`);
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
          if (zipHeader.signature !== 0x04034b50) {
            throw new Error(`Unexpected local-file-header-signature add position=${this.tokenizer.position - LocalFileHeaderToken.len}`);
          }
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

      if (zipHeader.dataDescriptor && zipHeader.compressedSize === 0) {
        const chunks: Uint8Array[] = [];
        let len = syncBufferSize;
        const ddSignatureArray = new Uint8Array(SignatureDataDescriptor)

        debug('Compressed-file-size unknown, scanning for next local-file-header');
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
        fileData = mergeArrays(chunks);
        // Set position to next ZIP header
      }

      if (!fileData) {
        fileData = new Uint8Array(zipHeader.compressedSize);
        await this.tokenizer.readBuffer(fileData);
      }

      if (zipHeader.dataDescriptor) {
        const dataDescriptor = await this.tokenizer.readToken(DataDescriptor);
        if (dataDescriptor.signature !== 0x08074b50) {
          throw new Error(`Expected data-descriptor-signature at position ${this.tokenizer.position - DataDescriptor.len}`);
        }
      }

      if (next.handler) {
        // Extract file data
        if (!fileData)
          throw new Error('fileData should be assigned');
        if (zipHeader.compressedMethod === 0) {
          await next.handler(fileData);
        } else {
          debug(`Decompress filename=${zipHeader.filename}, compressed-size=${fileData.length}`);
          const uncompressedData = decompressSync(fileData);
          await next.handler(uncompressedData);
        }
      }
      ++entry;
    } while (!stop && (!this.entries || entry < this.entries.length));
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