import {DOMParser} from 'xmldom';
import type {ITokenizer} from 'strtok3';
import {ZipHandler} from '../lib/index.js';

interface GenericFileType {
  mime: string;
  ext: string;
}

/**
 * Reads and processes Open Office XML document from a tokenizer.
 * Extracts the content type from `[Content_Types].xml` entry without buffering the entire archive.
 *
 * @param {ITokenizer} tokenizer - A tokenizer to read from.
 * @returns {Promise<string>} - ContentType without ".main+xml", or an error message.
 */
export async function scanOpenOfficeXmlDocFromTokenizer(tokenizer: ITokenizer): Promise<string | undefined> {

  const zipHandler = new ZipHandler(tokenizer);

  let docType: string | undefined = undefined;

  // await zipHandler.unzip(zipFile => {
  //   return zipFile.filename === '[Content_Types].xml' ? async fileData => {
  //     // Use TextDecoder to decode the UTF-8 encoded data
  //     const xmlContent = new TextDecoder('utf-8').decode(fileData);
  //
  //     const doc = new DOMParser().parseFromString(xmlContent, 'application/xml');
  //
  //     const overrideElements = doc.getElementsByTagName('Override');
  //     for (let i = 0; i < overrideElements.length; i++) {
  //       const contentType = overrideElements[i].getAttribute('ContentType');
  //       if (contentType && contentType.endsWith('.main+xml')) {
  //         docType = contentType.slice(0, -9);
  //         break;
  //       }
  //     }
  //   } : false;
  // });

  await zipHandler.unzip(zipFile => {
    const match = zipFile.filename === '[Content_Types].xml';
    return {
      handler: match ? async fileData => {
        // Use TextDecoder to decode the UTF-8 encoded data
        const xmlContent = new TextDecoder('utf-8').decode(fileData);

        const doc = new DOMParser().parseFromString(xmlContent, 'application/xml');

        const overrideElements = doc.getElementsByTagName('Override');
        for (let i = 0; i < overrideElements.length; i++) {
          const contentType = overrideElements[i].getAttribute('ContentType');
          if (contentType?.endsWith('.main+xml')) {
            docType = contentType.slice(0, -9);
            break;
          }
        }
      } : false,
      stop: match
    }
  });

  return docType;
}

// export type Detector = (tokenizer: ITokenizer, fileType?: FileTypeResult) => Promise<FileTypeResult | undefined>;

function mimeToExtension(mime: string): string | undefined {
  switch (mime) {
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xslx';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return 'pptx';
    case 'application/vnd.ms-visio.drawing':
      return 'vstx';
    default:
      return undefined;
  }
}

export async function detector(tokenizer: ITokenizer, result: GenericFileType): Promise<GenericFileType> {

  const buffer = new Uint8Array(4);
  const len = await tokenizer.peekBuffer(buffer);

  if (len === 4 && [0x50, 0x4B, 0x3, 0x4].every((v, i) => buffer[i] === v)) { // Local file header signature
    // Zip file detected
    const ooXmlMimeType = await scanOpenOfficeXmlDocFromTokenizer(tokenizer);
    if (ooXmlMimeType) {
      return {
        mime: ooXmlMimeType,
        ext: mimeToExtension(ooXmlMimeType) as string
      }
    }
    return {
      ext: 'zip',
      mime: 'application/zip',
    };
  }
  return result;
}
