import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { S3Client } from '@aws-sdk/client-s3';
import { makeChunkedTokenizerFromS3 } from '@tokenizer/s3';
import { assert } from 'chai';
import { it } from 'mocha';
import {
  fromBuffer,
  fromFile,
  fromStream,
  fromWebStream,
  type IRandomAccessTokenizer,
  type ITokenizer,
  TokenizerBoundaryError
} from 'strtok3';
import { UINT8 } from 'token-types';
import { GzipHandler, type ILocalFileHeader, ZipHandler } from '../lib/index.js';
import { MockS3Client } from './S3ClientMockup.js';
import { isTarHeaderChecksumMatches, makeReadableByteFileStream } from './util.js';

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

describe('Different ZIP encode options', () => {
  it('No data-descriptor, with extra-field-length in local-file-header;', async () => {
    const tokenizer = await makeFileTokenizer('fixture.docx');
    try {
      await checkContentTypesXml(tokenizer);
    } finally {
      await tokenizer.close();
    }
  });

  it('inflate fixture.xslx', async () => {
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

describe('Inflate some zip files', () => {
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

function assertFileIsXml(fileData: Uint8Array) {
  const xmlContent = new TextDecoder('utf-8').decode(fileData);
  assert.strictEqual(xmlContent.indexOf('<?xml version="1.0"'), 0, 'Content is XML');
}

describe('Inflate Gunzip', () => {
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

// One local header followed by a central-directory entry and EOCD record.
function makeZip() {
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

describe('Bounded ZIP central directory', () => {
  it('accepts an entry ending exactly at the directory boundary and preserves the source cursor', async () => {
    const tokenizer = fromBuffer(makeZip());
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
    it(`rejects a ${field} crossing the declared directory boundary`, async () => {
      const zip = makeZip();
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
    const zip = makeZip();
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
