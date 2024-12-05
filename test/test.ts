import {it} from 'mocha';
import {assert} from 'chai';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fromFile, fromStream, fromWebStream, type IRandomAccessTokenizer, type ITokenizer} from 'strtok3';
import {ZipHandler} from "../lib/index.js";
import {makeReadableByteFileStream} from "./util.js";
import {createReadStream} from "node:fs";
import type {ILocalFileHeader} from "../lib/ZipToken.js";

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
      }
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

async function checkContentTypesXml(tokenizer: ITokenizer): Promise<void> {
  const files = await extractFilesFromFixture(tokenizer);
  assert.isDefined(files);
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

  describe('inflate a ZIP file with the \"data descriptor\" flag not set', () => {

    it("inflate a ZIP file with the \"data descriptor\" flag disabled", async () => {
      const tokenizer = await makeFileTokenizer('fixture.docx');
      await checkContentTypesXml(tokenizer);
    });

    it("inflate fixture.xslx", async () => {
      const tokenizer = await makeFileTokenizer('fixture.xlsx');
      const files = await extractFilesFromFixture(tokenizer);
      assert.isDefined(files);
      const filename = '[Content_Types].xml';
      const contentTypeFile = findFile(files, filename);
      assert.isDefined(contentTypeFile, `Find file "${filename}"`);
      assert.strictEqual(contentTypeFile.data.length, 1336);
    });

  });

  describe('inflate a ZIP file with the \"data descriptor\" flag set', () => {

    it("from file: with random-read support", async () => {
      const tokenizer = await makeFileTokenizer('file_example_XLSX_10.xlsx');
      await checkContentTypesXml(tokenizer);
    });

    it("from web-stream: without random-read support", async () => {
      const tokenizer = await makeWebStreamTokenizer('file_example_XLSX_10.xlsx');
      await checkContentTypesXml(tokenizer);
    });

    it("from Node.js-stream: without random-read support", async () => {
      const tokenizer = await makeNodeStreamTokenizer('file_example_XLSX_10.xlsx');
      await checkContentTypesXml(tokenizer);
    });

  });

  it("extract uncompressed data", async () => {
    const tokenizer = await makeFileTokenizer('fixture.odp');
    const files = await extractFilesFromFixture(tokenizer);
    const filename = 'mimetype';
    const file = findFile(files, filename);
    assert.isDefined(file, `Find file "${filename}"`);
    const text = new TextDecoder('utf-8').decode(file.data);
    assert.isDefined(file.data, 'file.data');
    assert.strictEqual(text, 'application/vnd.oasis.opendocument.presentation')
  });

  it("inflate deflate", async () => {
    const tokenizer = await makeFileTokenizer('sample-deflate.zip');
    const files = await extractFilesFromFixture(tokenizer);
    assert.strictEqual(getInflatedFileLength(files, 'sample3.doc'), 15684);
  });

  it("inflate deflate64", async () => {
    const tokenizer = await makeFileTokenizer('sample-deflate64.zip');
    const files = await extractFilesFromFixture(tokenizer);
    assert.strictEqual(getInflatedFileLength(files, 'sample3.doc'), 15684);
  });

});

describe('Inflate some zip files', () => {

  it("inflate sample-4", async () => {
    const tokenizer = await makeFileTokenizer('sample-zip-files-sample-4.zip');
    const files = await extractFilesFromFixture(tokenizer);
    assert.strictEqual(getInflatedFileLength(files, 'sample1.doc'), 9779);
  });

  it("inflate sample-5", async () => {
    const tokenizer = await makeFileTokenizer('sample-zip-files-sample-5.zip');
    const files = await extractFilesFromFixture(tokenizer);
    assert.strictEqual(getInflatedFileLength(files, 'sample2.doc'), 10199);
  });

  it("inflate sample-6", async () => {
    const tokenizer = await makeFileTokenizer('sample-zip-files-sample-6.zip');
    const files = await extractFilesFromFixture(tokenizer);
    assert.strictEqual(getInflatedFileLength(files, 'sample3.doc'), 15684);
  });

  it("inflate deflate64", async () => {
    const tokenizer = await makeFileTokenizer('sample-deflate64.zip');
    const files = await extractFilesFromFixture(tokenizer);
    assert.strictEqual(getInflatedFileLength(files, 'sample3.doc'), 15684);
  });

});

describe('Inflate fixture.zip', () => {

  it("from file", async () => {
    const tokenizer = await makeFileTokenizer('fixture.zip');
    const files = await extractFilesFromFixture(tokenizer);
    assert.strictEqual(getInflatedFileLength(files, 'test.jpg'), 2248);
  });

  it("from web-stream", async () => {
    const tokenizer = await makeWebStreamTokenizer('fixture.zip');
    const files = await extractFilesFromFixture(tokenizer);
    assert.strictEqual(getInflatedFileLength(files, 'test.jpg'), 2248);
  });

  it("from Node.js-stream", async () => {
    const tokenizer = await makeNodeStreamTokenizer('fixture.zip');
    const files = await extractFilesFromFixture(tokenizer);
    assert.strictEqual(getInflatedFileLength(files, 'test.jpg'), 2248);
  });

});

describe('Inflate somefile.csv.zip', () => {

  it("from file", async () => {
    const tokenizer = await makeFileTokenizer('somefile.csv.zip');
    const files = await extractFilesFromFixture(tokenizer);
    assert.strictEqual(getInflatedFileLength(files, 'somefile.csv'), 50);
  });

  it("from Node.js-stream", async () => {
    const tokenizer = await makeNodeStreamTokenizer('somefile.csv.zip');
    const files = await extractFilesFromFixture(tokenizer);
    assert.strictEqual(getInflatedFileLength(files, 'somefile.csv'), 50);
  });

  it("from web-stream", async () => {
    const tokenizer = await makeWebStreamTokenizer('somefile.csv.zip');
    const files = await extractFilesFromFixture(tokenizer);
    assert.strictEqual(getInflatedFileLength(files, 'somefile.csv'), 50);
  });

});

function assertFileIsXml(fileData: Uint8Array) {
  const xmlContent = new TextDecoder('utf-8').decode(fileData);
  assert.strictEqual(xmlContent.indexOf("<?xml version=\"1.0\""), 0);
}