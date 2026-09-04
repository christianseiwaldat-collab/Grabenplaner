"use strict";

const { serialize } = require("node:v8");
const { parentPort, workerData } = require("node:worker_threads");

const {
  inspectTradeFotoAccdbBuffer,
} = require("./tradefoto-accdb-import");
const { TradeFotoArticleImportError } = require("./tradefoto-article-import");

async function run() {
  const databaseBuffer = Buffer.from(workerData.databaseBytes);
  try {
    const prepared = await inspectTradeFotoAccdbBuffer(databaseBuffer, {
      fileName: workerData.fileName,
      password: workerData.password,
    });
    const serialized = serialize(prepared);
    const transferable = serialized.buffer.slice(
      serialized.byteOffset,
      serialized.byteOffset + serialized.byteLength,
    );
    parentPort.postMessage({ ok: true, serialized: transferable }, [transferable]);
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: error instanceof TradeFotoArticleImportError
        ? { code: error.code, status: error.status }
        : { code: "SALES_ARTICLE_ACCDB_PASSWORD_OR_FILE_INVALID", status: 422 },
    });
  } finally {
    workerData.password = "";
    databaseBuffer.fill(0);
  }
}

void run();
