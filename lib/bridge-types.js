/** Typed bridge error with a stable machine-readable code. */
export class BridgeError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = 'BridgeError';
        this.code = code;
        if (details !== undefined)
            this.details = details;
    }
}
