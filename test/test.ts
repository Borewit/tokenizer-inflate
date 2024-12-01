import {it} from 'mocha';
import {assert} from 'chai';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fromFile, fromStream, fromWebStream, type ITokenizer} from 'strtok3';
import {ZipHandler} from "../lib/index.js";
import {makeReadableByteFileStream} from "./util.js";
import {createReadStream} from "node:fs";

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

async function extractFileFromFixtureFromNodeStream(fixture: string, filename: string): Promise<Uint8Array | undefined> {

  const stream = await createReadStream(join(fixturePath, fixture));
  const tokenizer = await fromStream(stream);
  try {
    return await extractFileFromFixture(tokenizer, fixture, filename);
  } finally {
    await tokenizer.close();
  }
}

async function extractFileFromFixtureFromWebStream(fixture: string, filename: string): Promise<Uint8Array | undefined> {

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

  describe('inflate a ZIP file with the \"data descriptor\" flag not set', () => {

    it("inflate a ZIP file with the \"data descriptor\" flag disabled", async () => {
      const fileData = await extractFileFromFixtureFromFile('fixture.docx', '[Content_Types].xml');
      assert.isDefined(fileData);
      assertFileIsXml(fileData);
    });

    it("inflate fixture.xslx", async () => {
      const fileData = await extractFileFromFixtureFromFile('fixture.xlsx', '[Content_Types].xml');
      assert.isDefined(fileData);
      const text = new TextDecoder('utf-8').decode(fileData);
      assert.strictEqual(fileData.length, 1336);
    });

  });

  describe('inflate a ZIP file with the \"data descriptor\" flag set', () => {

    it("from file: with random-read support", async () => {
      const fileData = await extractFileFromFixtureFromFile('file_example_XLSX_10.xlsx', '[Content_Types].xml');
      assert.isDefined(fileData);
      assertFileIsXml(fileData);
    });

    it("from web-stream: without random-read support", async () => {
      const fileData = await extractFileFromFixtureFromWebStream('file_example_XLSX_10.xlsx', '[Content_Types].xml');
      assert.isDefined(fileData);
      assertFileIsXml(fileData);
    });

    it("from Node.js-stream: without random-read support", async () => {
      const fileData = await extractFileFromFixtureFromNodeStream('file_example_XLSX_10.xlsx', '[Content_Types].xml');
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
    assert.strictEqual(fileData.length, 15684);
  });

});

it("inflate fixture.zip from file", async () => {
  const fileData = await extractFileFromFixtureFromFile('fixture.zip', 'test.jpg');
  assert.isDefined(fileData);
  assert.strictEqual(fileData.length, 2248);
});

it("inflate fixture.zip from web-stream", async () => {
  const fileData = await extractFileFromFixtureFromWebStream('fixture.zip', 'test.jpg');
  assert.isDefined(fileData);
  assert.strictEqual(fileData.length, 2248);
});

it("inflate fixture.zip from Node.js-stream", async () => {
  const fileData = await extractFileFromFixtureFromNodeStream('fixture.zip', 'test.jpg');
  assert.isDefined(fileData);
  assert.strictEqual(fileData.length, 2248);
});

function assertFileIsXml(fileData: Uint8Array) {
  const xmlContent = new TextDecoder('utf-8').decode(fileData);
  assert.strictEqual(xmlContent.indexOf("<?xml version=\"1.0\""), 0);
}