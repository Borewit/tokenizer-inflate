import {it} from 'mocha';
import {assert} from 'chai';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fromFile, fromWebStream, type ITokenizer} from 'strtok3';
import {ZipHandler} from "../lib/index.js";
import {makeReadableByteFileStream} from "./util.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixture');

async function extractFileFromFixture(tokenizer: ITokenizer, fixture: string, filename: string): Promise<Uint8Array | undefined> {
  const zipHandler = new ZipHandler(tokenizer);
  let fileData: Uint8Array | undefined;
  await zipHandler.unzip(zipFile => {
    const match = zipFile.filename === filename;
    return {
      handler: match ? async _fileData => {
        fileData = _fileData;
      } : false,
      stop: match
    }
  });
  return fileData;
}

async function extractFileFromFixtureFromFile(fixture: string, filename: string): Promise<Uint8Array | undefined> {

  const tokenizer = await fromFile(join(fixturePath, fixture));
  try {
    return await extractFileFromFixture(tokenizer, fixture, filename);
  } finally {
    await tokenizer.close();
  }
}

async function extractFileFromFixtureFromStream(fixture: string, filename: string): Promise<Uint8Array | undefined> {

  const stream = await makeReadableByteFileStream(join(fixturePath, fixture));
  const tokenizer = fromWebStream(stream.stream);
  try {
    return await extractFileFromFixture(tokenizer, fixture, filename);
  } finally {
    await tokenizer.close();
    await stream.closeFile();
  }
}

describe('Different ZIP encode options', () => {

  it("inflate a ZIP file with the \"data descriptor\" flag disabled", async () => {
    const fileData = await extractFileFromFixtureFromFile('fixture.docx', '[Content_Types].xml');
    assert.isDefined(fileData);
    assertFileIsXml(fileData);
  });

  describe('inflate a ZIP file with the \"data descriptor\" flag set', () => {

    it("with random-read support", async () => {
      const fileData = await extractFileFromFixtureFromFile('file_example_XLSX_10.xlsx', '[Content_Types].xml');
      assert.isDefined(fileData);
      assertFileIsXml(fileData);
    });

    it("without random-read support", async () => {
      const fileData = await extractFileFromFixtureFromStream('file_example_XLSX_10.xlsx', '[Content_Types].xml');
      assert.isDefined(fileData);
      assertFileIsXml(fileData);
    });

  });

  it("extract uncompressed data", async () => {
    const fileData = await extractFileFromFixtureFromFile('fixture.odp', 'mimetype');
    assert.isDefined(fileData);
    const text = new TextDecoder('utf-8').decode(fileData);
    assert.strictEqual(text, 'application/vnd.oasis.opendocument.presentation')
  });

  it("inflate deflate", async () => {
    const fileData = await extractFileFromFixtureFromFile('sample-deflate.zip', 'sample3.doc');
    assert.isDefined(fileData);
    const text = new TextDecoder('utf-8').decode(fileData);
    assert.strictEqual(fileData.length, 15684);
  });

  it("inflate deflate64", async () => {
    const fileData = await extractFileFromFixtureFromFile('sample-deflate64.zip', 'sample3.doc');
    assert.isDefined(fileData);
    const text = new TextDecoder('utf-8').decode(fileData);
    assert.strictEqual(fileData.length, 15684);
  });

});

describe('Inflate some zip files', () => {

  it("inflate sample-4", async () => {
    const fileData = await extractFileFromFixtureFromFile('sample-zip-files-sample-4.zip', 'sample1.doc');
    assert.isDefined(fileData);
    const text = new TextDecoder('utf-8').decode(fileData);
    assert.strictEqual(fileData.length, 9779);
  });

  it("inflate sample-5", async () => {
    const fileData = await extractFileFromFixtureFromFile('sample-zip-files-sample-5.zip', 'sample2.doc');
    assert.isDefined(fileData);
    const text = new TextDecoder('utf-8').decode(fileData);
    assert.strictEqual(fileData.length, 10199);
  });

  it("inflate sample-6", async () => {
    const fileData = await extractFileFromFixtureFromFile('sample-zip-files-sample-6.zip', 'sample3.doc');
    assert.isDefined(fileData);
    const text = new TextDecoder('utf-8').decode(fileData);
    assert.strictEqual(fileData.length, 15684);
  });

  it("inflate deflate64", async () => {
    const fileData = await extractFileFromFixtureFromFile('sample-deflate64.zip', 'sample3.doc');
    assert.isDefined(fileData);
    const text = new TextDecoder('utf-8').decode(fileData);
    assert.strictEqual(fileData.length, 15684);
  });

});

function assertFileIsXml(fileData: Uint8Array) {
  const xmlContent = new TextDecoder('utf-8').decode(fileData);
  assert.strictEqual(xmlContent.indexOf("<?xml version=\"1.0\""), 0);
}