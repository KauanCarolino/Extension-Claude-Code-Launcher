// O host de extensões roda em Node, mas o projeto não depende de @types/node.
// Só o que é usado aqui é declarado.
declare class TextDecoder {
	constructor(label?: string);
	decode(input?: Uint8Array): string;
}

declare class TextEncoder {
	encode(input?: string): Uint8Array;
}

declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
