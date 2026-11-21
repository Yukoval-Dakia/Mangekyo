import { parentPort, workerData } from 'node:worker_threads';

const { wasm, input, limit } = workerData;
const compiled = new WebAssembly.Module(wasm);
if (WebAssembly.Module.imports(compiled).length) throw new Error('本机核验模块不能导入宿主能力。');
const { memory, buffer, verify } = new WebAssembly.Instance(compiled).exports;
if (!(memory instanceof WebAssembly.Memory) || typeof buffer !== 'function' || typeof verify !== 'function') {
  throw new Error('本机核验模块缺少所需的接口。');
}
const offset = buffer();
if (!Number.isSafeInteger(offset) || offset < 0 || offset >= memory.buffer.byteLength) {
  throw new Error('本机核验模块的缓冲区无效。');
}
if (input) {
  new Uint8Array(memory.buffer, offset, input.length).set(input);
  const length = verify(input.length);
  if (!Number.isSafeInteger(length) || length <= 0 || length > limit) throw new Error('本机核验结果长度无效。');
  parentPort.postMessage(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(memory.buffer, offset, length)));
} else {
  parentPort.postMessage('');
}
