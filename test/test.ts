import { it } from 'mocha';
import { assert } from 'chai';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {fromBuffer, fromFile, fromStream, fromWebStream, type IRandomAccessTokenizer, type ITokenizer} from 'strtok3';
import { makeReadableByteFileStream, isTarHeaderChecksumMatches } from "./util.js";
import { createReadStream } from "node:fs";
import { makeChunkedTokenizerFromS3 } from "@tokenizer/s3";
import { MockS3Client } from "./S3ClientMockup.js";
import type { S3Client } from "@aws-sdk/client-s3";

import { ZipHandler, type ILocalFileHeader, GzipHandler } from "../lib/index.js";

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
  return fromWebStream(stream.stream);
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

  it("No data-descriptor, with extra-field-length in local-file-header;", async () => {
    const tokenizer = await makeFileTokenizer('fixture.docx');
    try {
      await checkContentTypesXml(tokenizer);
    } finally {
      await tokenizer.close();
    }
  });

  it("inflate fixture.xslx", async () => {
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

    it("from file (with random-read)", async () => {
      const tokenizer = await makeFileTokenizer('file_example_XLSX_10.xlsx');
      try {
        await checkContentTypesXml(tokenizer);

      } finally {
        await tokenizer.close();
      }
    });

    it("from web-stream (without random-read)", async () => {
      const tokenizer = await makeWebStreamTokenizer('file_example_XLSX_10.xlsx');
      try {
        await checkContentTypesXml(tokenizer);

      } finally {
        await tokenizer.close();
      }
    });

    it("from Node.js-stream (without random-read)", async () => {
      const tokenizer = await makeNodeStreamTokenizer('file_example_XLSX_10.xlsx');
      try {
        await checkContentTypesXml(tokenizer);
      } finally {
        await tokenizer.close();
      }
    });

  });

  it("extract uncompressed data", async () => {
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

  it("inflate deflate", async () => {
    const tokenizer = await makeFileTokenizer('sample-deflate.zip');
    try {
      const files = await extractFilesFromFixture(tokenizer);
      assert.strictEqual(getInflatedFileLength(files, 'sample3.doc'), 15684);
    } finally {
      await tokenizer.close();
    }
  });

  it("inflate deflate64", async () => {
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

  it("inflate sample-4", async () => {
    const tokenizer = await makeFileTokenizer('sample-zip-files-sample-4.zip');
    try {
      const files = await extractFilesFromFixture(tokenizer);
      assert.strictEqual(getInflatedFileLength(files, 'sample1.doc'), 9779);
    } finally {
      await tokenizer.close();
    }

  });

  it("inflate sample-5", async () => {
    const tokenizer = await makeFileTokenizer('sample-zip-files-sample-5.zip');
    try {
      const files = await extractFilesFromFixture(tokenizer);
      assert.strictEqual(getInflatedFileLength(files, 'sample2.doc'), 10199);
    } finally {
      await tokenizer.close();
    }
  });

  it("inflate sample-6", async () => {
    const tokenizer = await makeFileTokenizer('sample-zip-files-sample-6.zip');
    try {
      const files = await extractFilesFromFixture(tokenizer);
      assert.strictEqual(getInflatedFileLength(files, 'sample3.doc'), 15684);
    } finally {
      await tokenizer.close();
    }
  });

  it("inflate deflate64", async () => {
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

  it("from file", async () => {
    const tokenizer = await makeFileTokenizer('fixture.zip');
    try {
      const files = await extractFilesFromFixture(tokenizer);
      assert.strictEqual(getInflatedFileLength(files, 'test.jpg'), 2248);
    } finally {
      await tokenizer.close();
    }
  });

  it("from web-stream", async () => {
    const tokenizer = await makeWebStreamTokenizer('fixture.zip');
    try {
      const files = await extractFilesFromFixture(tokenizer);
      assert.strictEqual(getInflatedFileLength(files, 'test.jpg'), 2248);
    } finally {
      await tokenizer.close();
    }
  });

  it("from Node.js-stream", async () => {
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

  it("from file", async () => {
    const tokenizer = await makeFileTokenizer('somefile.csv.zip');
    try {
      const files = await extractFilesFromFixture(tokenizer);
      assert.strictEqual(getInflatedFileLength(files, 'somefile.csv'), 50);
    } finally {
      await tokenizer.close();
    }
  });

  it("from Node.js-stream", async () => {
    const tokenizer = await makeNodeStreamTokenizer('somefile.csv.zip');
    try {
      const files = await extractFilesFromFixture(tokenizer);
      assert.strictEqual(getInflatedFileLength(files, 'somefile.csv'), 50);
    } finally {
      await tokenizer.close();
    }
  });

  it("from web-stream", async () => {
    const tokenizer = await makeWebStreamTokenizer('somefile.csv.zip');
    try {
      const files = await extractFilesFromFixture(tokenizer);
      assert.strictEqual(getInflatedFileLength(files, 'somefile.csv'), 50);
    } finally {
      await tokenizer.close();
    }
  });

  it("from S3 mockup", async () => {
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
  assert.strictEqual(xmlContent.indexOf("<?xml version=\"1.0\""), 0, 'Content is XML');
}

describe("Inflate Gunzip", () => {

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
    const gzipHandler = new GzipHandler(tokenizer);
    const readableStream = gzipHandler.inflate();
    const reader = readableStream.getReader();
    let decodedResult = await reader.read();
    assert.strictEqual(decodedResult.done, false, 'decodedResult.done');
    const decodedText = new TextDecoder('ascii').decode(decodedResult.value);
    assert.strictEqual(decodedText,'Lorem ipsum dolor sit amet, consectetur adipiscing elit. \n' +
      'Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\n', 'decoded text');
    decodedResult = await reader.read();
    assert.strictEqual(decodedResult.done, true, 'decodedResult.done');
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

  it('Inflate large tar.gz file', async () => {
    const result = await fetch("https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.7.12.tar.gz");
    assert.ok(result.ok, 'HTTP request is ok');
    if (result.body !== null) {
      const tokenizer = fromWebStream(result.body);
      try {
        assert.isTrue(await isTarGz(tokenizer));
      } finally {
        await tokenizer.close();
      }
    } else {
      assert.fail('Could not stream HTTP result');
    }
  });

});
