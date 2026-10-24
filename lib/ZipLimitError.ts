/** Opt-in ZIP processing limits. Byte limits exclude bounded descriptor lookahead. */
export interface ZipProcessingLimits {
  /** Maximum entries visited in one traversal, including ignored entries. */
  maxEntryCount?: number;
  /** Maximum metadata and compressed-data bytes consumed in one traversal, excluding seek distances. */
  maxTotalScanBytes?: number;
  /** Maximum bytes scanned across all entries with unknown compressed sizes. */
  maxTotalDataDescriptorScanBytes?: number;
  /** Maximum compressed bytes skipped for one ignored entry. */
  maxSkippedEntrySize?: number;
  /** Maximum bytes scanned before a data descriptor, including ignored entries. */
  maxDataDescriptorScanBytes?: number;
  /** Maximum compressed bytes buffered for a selected entry. */
  maxCompressedSize?: number;
  /** Maximum decompressed bytes retained for a selected entry (including stored entries). */
  maxUncompressedSize?: number;
}

export interface ZipHandlerOptions extends ZipProcessingLimits {
  /** Use the central directory on random-access inputs. Defaults to true. */
  useCentralDirectory?: boolean;
  /** Deliver available entry data before a truncated/missing descriptor fails. Intended for detection. */
  allowTruncatedDataDescriptor?: boolean;
}

/** A configured ZIP processing limit was exceeded. */
export class ZipLimitError extends RangeError {
  constructor(
    public readonly limit: keyof ZipProcessingLimits,
    public readonly requestedSize: number,
    public readonly maxSize: number
  ) {
    super(`ZIP ${limit} exceeded: ${requestedSize} exceeds limit of ${maxSize}`);
    this.name = 'ZipLimitError';
  }
}
