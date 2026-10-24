import initDebug from 'debug';
import { createTokenizerView, type IGetToken, type IRandomAccessTokenizer, type ITokenizer } from 'strtok3/core';
import { StringType, UINT32_LE } from 'token-types';
import { type ZipHandlerOptions, ZipLimitError, type ZipProcessingLimits } from './ZipLimitError.js';
import {
  DataDescriptor,
  EndOfCentralDirectoryRecordToken,
  FileHeader,
  type IFileHeader,
  type ILocalFileHeader,
  LocalFileHeaderToken,
  Signature
} from './ZipToken.js';

export type InflateFileFilterResult = {
  handler: InflatedDataHandler | false; // Function to handle extracted file data
  stop?: boolean; // Signal to stop processing further files
};

export type { ILocalFileHeader } from './ZipToken.js';

function signatureToArray(signature: number): Uint8Array {
  const signatureBytes = new Uint8Array(UINT32_LE.len);
  UINT32_LE.put(signatureBytes, 0, signature);
  return signatureBytes;
}

const debug = initDebug('tokenizer:inflate');

const syncBufferSize = 256 * 1024;

const eocdSignatureBytes = signatureToArray(Signature.EndOfCentralDirectory);

/**
 * Return false when to ignore the file, return `InflatedDataHandler` to handle extracted data
 */
export type InflateFileFilter = (file: ILocalFileHeader) => InflateFileFilterResult;

export type InflatedDataHandler = (fileData: Uint8Array) => Promise<void>;

export class ZipHandler {
  private syncBuffer = new Uint8Array(syncBufferSize);

  private readonly limits: Required<ZipProcessingLimits>;
  private readonly useCentralDirectory: boolean;
  private readonly allowTruncatedDataDescriptor: boolean;
  private scannedBytes = 0;
  private descriptorScannedBytes = 0;

  constructor(
    private tokenizer: ITokenizer,
    options: ZipHandlerOptions = {}
  ) {
    this.limits = {
      maxEntryCount: options.maxEntryCount ?? Number.POSITIVE_INFINITY,
      maxTotalScanBytes: options.maxTotalScanBytes ?? Number.POSITIVE_INFINITY,
      maxTotalDataDescriptorScanBytes: options.maxTotalDataDescriptorScanBytes ?? Number.POSITIVE_INFINITY,
      maxSkippedEntrySize: options.maxSkippedEntrySize ?? Number.POSITIVE_INFINITY,
      maxDataDescriptorScanBytes: options.maxDataDescriptorScanBytes ?? Number.POSITIVE_INFINITY,
      maxCompressedSize: options.maxCompressedSize ?? Number.POSITIVE_INFINITY,
      maxUncompressedSize: options.maxUncompressedSize ?? Number.POSITIVE_INFINITY
    };
    this.useCentralDirectory = options.useCentralDirectory ?? true;
    this.allowTruncatedDataDescriptor = options.allowTruncatedDataDescriptor ?? false;
    if (typeof this.useCentralDirectory !== 'boolean') {
      throw new TypeError('useCentralDirectory must be a boolean');
    }
    if (typeof this.allowTruncatedDataDescriptor !== 'boolean') {
      throw new TypeError('allowTruncatedDataDescriptor must be a boolean');
    }
    for (const [name, limit] of Object.entries(this.limits)) {
      if (limit !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(limit) || limit <= 0)) {
        throw new RangeError(`${name} must be a positive safe integer or Infinity`);
      }
    }
  }

  /** Reject oversized entries before retaining data or allocating a combined buffer. */
  private checkLimit(limit: keyof ZipProcessingLimits, size: number): void {
    if (size > this.limits[limit]) {
      throw new ZipLimitError(limit, size, this.limits[limit]);
    }
  }

  private resetTraversal(): void {
    this.scannedBytes = 0;
    this.descriptorScannedBytes = 0;
  }

  private consumeBytes(length: number): void {
    this.checkLimit('maxTotalScanBytes', this.scannedBytes + length);
    this.scannedBytes += length;
  }

  private readToken<T>(token: IGetToken<T>, input: ITokenizer = this.tokenizer): Promise<T> {
    this.consumeBytes(token.len);
    return input.readToken(token);
  }

  private ignore(length: number, input: ITokenizer = this.tokenizer): Promise<number> {
    this.consumeBytes(length);
    return input.ignore(length);
  }

  private readData(length: number): Promise<Uint8Array> {
    this.consumeBytes(length);
    const data = new Uint8Array(length);
    return this.tokenizer.readBuffer(data).then(() => data);
  }

  private checkEntrySize(header: ILocalFileHeader): void {
    this.checkLimit('maxCompressedSize', header.compressedSize);
    this.checkLimit('maxUncompressedSize', header.uncompressedSize);
    if (header.compressedMethod === 0) {
      this.checkLimit('maxUncompressedSize', header.compressedSize);
    }
  }

  async isZip(): Promise<boolean> {
    return (await this.peekSignature()) === Signature.LocalFileHeader;
  }

  private peekSignature(): Promise<number> {
    return this.tokenizer.peekToken(UINT32_LE);
  }

  async findEndOfCentralDirectoryLocator(): Promise<number> {
    const randomReadTokenizer = this.tokenizer as IRandomAccessTokenizer;
    const chunkLength = Math.min(16 * 1024, randomReadTokenizer.fileInfo.size);
    const buffer = this.syncBuffer.subarray(0, chunkLength);
    this.consumeBytes(chunkLength);
    await this.tokenizer.readBuffer(buffer, { position: randomReadTokenizer.fileInfo.size - chunkLength });
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
    this.resetTraversal();
    const entries = await this.centralDirectoryEntries();
    if (!entries) {
      return;
    }
    const files: IFileHeader[] = [];
    for await (const entry of entries) {
      files.push(entry);
    }
    return files;
  }

  private async centralDirectoryEntries(): Promise<AsyncGenerator<IFileHeader> | undefined> {
    if (!this.tokenizer.supportsRandomAccess()) {
      debug('Cannot reading central-directory without random-read support');
      return;
    }
    debug('Reading central-directory...');
    const pos = this.tokenizer.position;
    try {
      const offset = await this.findEndOfCentralDirectoryLocator();
      if (offset > 0) {
        debug('Central-directory 32-bit signature found');
        (this.tokenizer as IRandomAccessTokenizer).setPosition(offset);
        const eocdHeader = await this.readToken(EndOfCentralDirectoryRecordToken);
        return this.iterateDirectory(eocdHeader.offsetOfStartOfCd, eocdHeader.sizeOfCd, eocdHeader.nrOfEntriesOfSize);
      }
    } finally {
      (this.tokenizer as IRandomAccessTokenizer).setPosition(pos);
    }
  }

  private async *iterateDirectory(offset: number, size: number, count: number): AsyncGenerator<IFileHeader> {
    const source = this.tokenizer as IRandomAccessTokenizer;
    const pos = source.position;
    let directory: IRandomAccessTokenizer | undefined;
    let position = 0;
    try {
      source.setPosition(offset);
      directory = createTokenizerView(source, size) as IRandomAccessTokenizer;
      for (let n = 0; n < count; ++n) {
        this.checkLimit('maxEntryCount', n + 1);
        // Extraction between yields can move the source to a local header.
        directory.setPosition(position);
        const entry = await this.readToken(FileHeader, directory);
        if (entry.signature !== Signature.CentralFileHeader) {
          throw new Error('Expected Central-File-Header signature');
        }
        entry.filename = await this.readToken(new StringType(entry.filenameLength, 'utf-8'), directory);
        await this.ignore(entry.extraFieldLength, directory);
        await this.ignore(entry.fileCommentLength, directory);
        position = directory.position;
        yield entry;
      }
    } finally {
      try {
        await directory?.close();
      } finally {
        source.setPosition(pos);
      }
    }
  }

  async unzip(fileCb: InflateFileFilter): Promise<void> {
    this.resetTraversal();
    const entries = this.useCentralDirectory ? await this.centralDirectoryEntries() : undefined;
    if (entries) {
      // Use Central Directory to iterate over files
      return this.iterateOverCentralDirectory(entries, fileCb);
    }

    // Scan Zip files for local-file-header
    let stop = false;
    let entryCount = 0;
    do {
      const zipHeader = await this.readLocalFileHeader();
      if (!zipHeader) {
        break;
      }
      this.checkLimit('maxEntryCount', ++entryCount);

      const next = fileCb(zipHeader);
      stop = !!next.stop;

      let fileData: Uint8Array | undefined;

      await this.ignore(zipHeader.extraFieldLength);

      if (next.handler) {
        this.checkEntrySize(zipHeader);
      } else {
        this.checkLimit('maxSkippedEntrySize', zipHeader.compressedSize);
      }
      if (zipHeader.dataDescriptor && zipHeader.compressedSize === 0) {
        const chunks: Uint8Array[] = [];
        let totalSize = 0;
        const scanLimit = Math.min(
          this.limits.maxDataDescriptorScanBytes,
          this.limits.maxTotalDataDescriptorScanBytes - this.descriptorScannedBytes,
          this.limits.maxTotalScanBytes - this.scannedBytes,
          next.handler ? Number.POSITIVE_INFINITY : this.limits.maxSkippedEntrySize,
          next.handler ? this.limits.maxCompressedSize : Number.POSITIVE_INFINITY,
          next.handler && zipHeader.compressedMethod === 0 ? this.limits.maxUncompressedSize : Number.POSITIVE_INFINITY
        );

        debug('Compressed-file-size unknown, scanning for next data-descriptor-signature....');
        while (true) {
          // Retain a full descriptor overlap so its compressed-size field can be validated.
          const peekLength = Math.min(syncBufferSize, scanLimit - totalSize + DataDescriptor.len);
          const len = await this.tokenizer.peekBuffer(this.syncBuffer.subarray(0, peekLength), { mayBeLess: true });
          const allowTruncated = this.allowTruncatedDataDescriptor && len < peekLength;
          const nextHeaderIndex = findDescriptor(this.syncBuffer.subarray(0, len), totalSize, allowTruncated);
          if (nextHeaderIndex < 0 && len < DataDescriptor.len && !allowTruncated) {
            throw new Error('Expected data-descriptor-signature before end of input');
          }
          const size = nextHeaderIndex >= 0 ? nextHeaderIndex : allowTruncated ? len : len - DataDescriptor.len + 1;
          if (size === 0) {
            break;
          }
          this.checkLimit('maxDataDescriptorScanBytes', totalSize + size);
          this.checkLimit('maxTotalDataDescriptorScanBytes', this.descriptorScannedBytes + size);
          if (!next.handler) {
            this.checkLimit('maxSkippedEntrySize', totalSize + size);
          }
          if (next.handler) {
            this.checkLimit('maxCompressedSize', totalSize + size);
            if (zipHeader.compressedMethod === 0) {
              this.checkLimit('maxUncompressedSize', totalSize + size);
            }
            if (size > 0) {
              const data = await this.readData(size);
              chunks.push(data);
            }
          } else {
            await this.ignore(size);
          }
          totalSize += size;
          this.descriptorScannedBytes += size;
          if (nextHeaderIndex >= 0) {
            break;
          }
        }
        debug(`Found data-descriptor-signature at pos=${this.tokenizer.position}`);
        if (next.handler) {
          this.checkLimit('maxCompressedSize', totalSize);
          await this.inflate(zipHeader, mergeArrays(chunks), next.handler);
        }
      } else {
        if (next.handler) {
          debug(`Reading compressed-file-data: ${zipHeader.compressedSize} bytes`);
          fileData = await this.readData(zipHeader.compressedSize);
          await this.inflate(zipHeader, fileData, next.handler as InflatedDataHandler);
        } else {
          debug(`Ignoring compressed-file-data: ${zipHeader.compressedSize} bytes`);
          await this.ignore(zipHeader.compressedSize);
        }
      }

      debug(`Reading data-descriptor at pos=${this.tokenizer.position}`);
      if (zipHeader.dataDescriptor) {
        // await this.tokenizer.ignore(DataDescriptor.len);
        const dataDescriptor = await this.readToken(DataDescriptor);
        if (dataDescriptor.signature !== 0x08074b50) {
          throw new Error(
            `Expected data-descriptor-signature at position ${this.tokenizer.position - DataDescriptor.len}`
          );
        }
      }
    } while (!stop);
  }

  private async iterateOverCentralDirectory(entries: AsyncIterable<IFileHeader>, fileCb: InflateFileFilter) {
    for await (const fileHeader of entries) {
      const next = fileCb(fileHeader);
      if (next.handler) {
        (this.tokenizer as IRandomAccessTokenizer).setPosition(fileHeader.relativeOffsetOfLocalHeader);
        const zipHeader = await this.readLocalFileHeader();
        if (zipHeader) {
          await this.ignore(zipHeader.extraFieldLength);
          this.checkEntrySize(fileHeader);
          this.checkEntrySize(zipHeader);
          const fileData = await this.readData(fileHeader.compressedSize);
          await this.inflate(zipHeader, fileData, next.handler);
        }
      }
      if (next.stop) {
        break;
      }
    }
  }

  private async inflate(zipHeader: ILocalFileHeader, fileData: Uint8Array, cb: InflatedDataHandler): Promise<void> {
    if (zipHeader.compressedMethod === 0) {
      // Stored (uncompressed)
      this.checkLimit('maxUncompressedSize', fileData.length);
      return cb(fileData);
    }

    if (zipHeader.compressedMethod !== 8) {
      throw new Error(`Unsupported ZIP compression method: ${zipHeader.compressedMethod}`);
    }

    debug(`Decompress filename=${zipHeader.filename}, compressed-size=${fileData.length}`);

    const uncompressedData = await this.decompressDeflateRaw(fileData);
    return cb(uncompressedData);
  }

  private async decompressDeflateRaw(data: Uint8Array): Promise<Uint8Array> {
    // Wrap Uint8Array in a ReadableStream without copying
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      }
    });

    const ds = new DecompressionStream('deflate-raw');
    const output = input.pipeThrough(ds as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);

    const reader = output.getReader();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        this.checkLimit('maxUncompressedSize', totalSize + value.length);
        totalSize += value.length;
        chunks.push(value);
      }
      this.checkLimit('maxUncompressedSize', totalSize);
      return mergeArrays(chunks);
    } catch (err: unknown) {
      // Cancellation propagates through pipeThrough to stop decompression.
      await reader.cancel(err).catch(() => {
        // Preserve the original failure if cancellation also fails.
      });
      if (err instanceof ZipLimitError) {
        throw err;
      }
      // Descriptor scanning can retain bytes after the deflate stream, including
      // unsigned ZIP data descriptors. Node.js rejects these after delivering the
      // inflated data. Recover only this error; every retained chunk was bounded.
      if (err instanceof Error && 'code' in err && err.code === 'ERR_TRAILING_JUNK_AFTER_STREAM_END') {
        return mergeArrays(chunks);
      }
      // Provide ZIP-specific error context
      const message =
        err instanceof Error
          ? `Failed to deflate ZIP entry: ${err.message}`
          : 'Unknown decompression error in ZIP entry';

      throw new TypeError(message);
    } finally {
      reader.releaseLock();
    }
  }

  private async readLocalFileHeader(): Promise<ILocalFileHeader | false> {
    const signature = await this.tokenizer.peekToken(UINT32_LE);
    if (signature === Signature.LocalFileHeader) {
      const header = await this.readToken(LocalFileHeaderToken);
      header.filename = await this.readToken(new StringType(header.filenameLength, 'utf-8'));
      return header;
    }
    if (signature === Signature.CentralFileHeader) {
      return false;
    }
    if (signature === 0xe011cfd0) {
      throw new Error('Encrypted ZIP');
    }
    throw new Error('Unexpected signature');
  }
}

function findDescriptor(buffer: Uint8Array, consumed: number, allowTruncated: boolean): number {
  for (let i = 0; i <= buffer.length - (allowTruncated ? 4 : DataDescriptor.len); i++) {
    if (
      UINT32_LE.get(buffer, i) === Signature.DataDescriptor &&
      (buffer.length - i < 12 || UINT32_LE.get(buffer, i + 8) === consumed + i)
    ) {
      return i;
    }
  }

  return -1;
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
