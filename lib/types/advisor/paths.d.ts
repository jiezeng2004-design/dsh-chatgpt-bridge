import type { ExtraMatcher } from './sensitive.js';
export declare function advisorError(code: string, message: string): never;
/** One gate for caller paths and paths discovered by all data-plane readers. */
export declare function workspacePath(root: string, input: string, extra?: ExtraMatcher): Promise<{
    absolute: string;
    canonical: string;
    relative: string;
    info: import("fs").Stats | undefined;
}>;
/** Round a byte position down to a UTF-8 character boundary. */
export declare function utf8Boundary(buffer: Buffer, position: number): number;
