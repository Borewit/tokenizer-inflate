import {it} from 'mocha';
import {assert} from 'chai';
import {detector, scanOpenOfficeXmlDocFromTokenizer} from "./ooxml.js";
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fromFile} from 'strtok3';
import {type Detector, NodeFileTypeParser} from 'file-type';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixture');

async function getMimeFromFixtureAsTokenizer(fixture: string): Promise<string | undefined> {
  const tokenizer = await fromFile(join(fixturePath, fixture));
  try {
    return await scanOpenOfficeXmlDocFromTokenizer(tokenizer);
  } finally {
    await tokenizer.close();
  }
}

const mimeType = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  vsdx: 'application/vnd.ms-visio.drawing'
};

const fixtures = [
  {
    fixture: 'file_example_XLSX_10.xlsx',
    type: mimeType.xlsx,
  },
  {
    fixture: 'fixture.docx',
    type: mimeType.docx,
  },
  {
    fixture: 'fixture.xlsx',
    type: mimeType.xlsx,
  },
  {
    fixture: 'fixture2.pptx',
    type: mimeType.pptx,
  },
  {
    fixture: 'fixture2.xlsx',
    type: mimeType.xlsx,
  },
  {
    fixture: 'fixture.docx',
    type: mimeType.docx,
  },
  {
    fixture: 'fixture-vsdx.vsdx',
    type: mimeType.vsdx,
  },
  {
    fixture: 'fixture-vstx.vsdx',
    type: mimeType.vsdx,
  }
];

describe('Test OOXML fixtures', () => {

  for(const fixture of fixtures) {
    describe(`fixture "${fixture.fixture}"`, () => {

      it("from tokenizer", async () => {
        assert.strictEqual(await getMimeFromFixtureAsTokenizer(fixture.fixture), fixture.type);
      });

      it("file-type", async () => {
        const customDetectors: Iterable<Detector> = [detector as unknown as Detector];
        const fileTypeParser = new NodeFileTypeParser({
          customDetectors,
          signal: undefined as unknown as AbortSignal
        });
        const path = join(fixturePath, fixture.fixture);
        const type = await fileTypeParser.fromFile(path);
        assert.isDefined(type);
        assert.strictEqual(type.mime, fixture.type);
        assert.isDefined(type.ext);
      });

    });
  }
});

it("single file", async () => {
  assert.strictEqual(await getMimeFromFixtureAsTokenizer(fixtures[0].fixture), fixtures[0].type);
});