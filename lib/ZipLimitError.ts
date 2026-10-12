/** Opt-in per-entry ZIP processing limits, in bytes. */
export interface ZipHandlerOptions {
  /** Maximum bytes scanned before a data descriptor, including ignored entries. */
  maxDataDescriptorScanBytes?: number;
  /** Maximum compressed bytes buffered for a selected entry. */
  maxCompressedSize?: number;
  /** Maximum decompressed bytes retained for a selected entry (including stored entries). */
  maxUncompressedSize?: number;
}

/** A configured ZIP processing limit was exceeded. */
export class ZipLimitError extends RangeError {
  constructor(
    public readonly limit: keyof ZipHandlerOptions,
    public readonly requestedSize: number,
    public readonly maxSize: number
  ) {
    super(`ZIP ${limit} exceeded: ${requestedSize} bytes exceeds limit of ${maxSize} bytes`);
    this.name = 'ZipLimitError';
  }
}
