[![Node.js CI](https://github.com/Borewit/tokenizer-deflate/actions/workflows/nodejs-ci.yml/badge.svg)](https://github.com/Borewit/tokenizer-deflate/actions/workflows/nodejs-ci.yml)
[![NPM version](https://badge.fury.io/js/%40tokenizer%2Fdeflate.svg)](https://npmjs.org/package/@tokenizer/deflate)
[![npm downloads](https://img.shields.io/npm/dm/@tokenizer%2Fdeflate.svg)](https://npmcharts.com/compare/%40tokenizer%2Fdeflate?start=1200&interval=30)
[![Bundle Size](https://pkg-size.dev/badge/bundle/8168)](https://pkg-size.dev/@tokenizer/deflate)

# @tokenizer/deflate

`@tokenizer/deflate` is a package designed for handling and extracting data from ZIP files efficiently using a tokenizer-based approach.
The library provides a customizable way to parse ZIP archives and extract compressed data while minimizing memory usage.

## Features
- Read and extract files from ZIP archives.
- Filter files based on custom criteria using callback functions.
- Handle extracted data using user-defined handlers.
- Interrupt the extraction process conditionally.

## Installation
```bash
npm install @tokenizer/deflate
```

## Usage

### Example: Extracting Specific Files

The following example demonstrates how to use the library to extract .txt files and stop processing when encountering a .stop file.

```ts
import { ZipHandler, InflateFileFilter } from "@tokenizer/deflate";
import { fromFile } from "strtok3";

const fileFilter: InflateFileFilter = (file) => {
  console.log(`Processing file: ${file.filename}`);

  if (file.filename?.endsWith(".stop")) {
    console.log(`Stopping processing due to file: ${file.filename}`);
    return { handler: false, stop: true }; // Stop the unzip process
  }

  if (file.filename?.endsWith(".txt")) {
    return {
      handler: async (data) => {
        console.log(`Extracted text file: ${file.filename}`);
        console.log(new TextDecoder().decode(data));
      },
    };
  }

  return { handler: false }; // Ignore other files
};

async function extractFiles(zipFilePath: string) {
  const tokenizer = await fromFile(zipFilePath);
  const zipHandler = new ZipHandler(tokenizer);

  await zipHandler.unzip(fileFilter);
}

extractFiles("example.zip").catch(console.error);

```

### Example: Custom File Handling
Define custom logic to handle specific files or stop extraction based on file attributes.

```ts
const fileFilter: InflateFileFilter = (file) => {
  if (file.filename?.endsWith(".log")) {
    return {
      handler: async (data) => {
        console.log(`Processing log file: ${file.filename}`);
        const content = new TextDecoder().decode(data);
        console.log(content);
      },
    };
  }

  return { handler: false }; // Skip other files
};
```

## API

### `ZipHandler`
A class for handling ZIP file parsing and extraction.
#### Constructor
```ts
new ZipHandler(tokenizer: ITokenizer)
```
- **tokenizer**: An instance of ITokenizer to read the ZIP archive.
#### Methods
 
- `isZip(): Promise<boolean>`

   Determines whether the input file is a ZIP archive.

- `unzip(fileCb: InflateFileFilter): Promise<void>`

  Extracts files from the ZIP archive, applying the provided `InflateFileFilter` callback to each file.

```InflatedDataHandler``` 

## Types

### `InflateFileFilter`
```ts
type InflateFileFilter = (file: IFullZipHeader) => InflateFileFilterResult;
```
Callback function to determine whether a file should be handled or ignored.

### `InflateFileFilterResult`
```ts
type InflateFileFilterResult = {
  handler: InflatedDataHandler | false; // Handle file data or ignore
  stop?: boolean; // Stop processing further files
};

```
Returned from `InflateFileFilter` to control file handling and extraction flow.

### `InflatedDataHandler`
```ts
type InflatedDataHandler = (fileData: Uint8Array) => Promise<void>;
```
Handler for processing uncompressed file data.

## Compatibility

Starting with version 7, the module has migrated from [CommonJS](https://en.wikipedia.org/wiki/CommonJS) to [pure ECMAScript Module (ESM)](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c).
The distributed JavaScript codebase is compliant with the [ECMAScript 2020 (11th Edition)](https://en.wikipedia.org/wiki/ECMAScript_version_history#11th_Edition_%E2%80%93_ECMAScript_2020) standard.

## License
This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.