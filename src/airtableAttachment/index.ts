// airtableAttachment.ts

import objectSize from "./objectSize.js";

export type ObjectOrBuffer =
    | Record<string, unknown>
    | ArrayBuffer
    | ArrayBufferView
    | Blob;

export type ObjectSizeReturnType = ReturnType<typeof objectSize>;

export type DataTooLargeResult<T> = {
    error: "dataTooLarge";
    dataSize: ObjectSizeReturnType;
    data: T;
};

export type AirtableAttachmentSuccess<T, R = unknown> = {
    dataSize: ObjectSizeReturnType;
    data: T;
    response: R;
    status: number;
};

export type AirtableAttachmentResult<T, R = unknown> =
    | DataTooLargeResult<T>
    | AirtableAttachmentSuccess<T, R>;

export interface AirtableAttachmentModule {
    readonly apiKey: string;

    upload<T extends ObjectOrBuffer, R = unknown>(
        data: T,
        pathOrUrl: string,
    ): Promise<AirtableAttachmentResult<T, R>>;

    /**
     * Airtable attachments cannot be updated in place.
     *
     * This uploads another attachment to the target attachment cell.
     * Removing the previous attachment requires a record PATCH.
     */
    update<T extends ObjectOrBuffer, R = unknown>(
        data: T,
        pathOrUrl: string,
    ): Promise<AirtableAttachmentResult<T, R>>;

    /**
     * Patches an Airtable record with the supplied JSON object.
     *
     * Example data:
     * {
     *   fields: {
     *     Attachments: []
     *   }
     * }
     */
    delete<T extends ObjectOrBuffer, R = unknown>(
        data: T,
        pathOrUrl: string,
    ): Promise<AirtableAttachmentSuccess<T, R>>;
}

export interface AirtableAttachmentHttpErrorOptions {
    status: number;
    statusText: string;
    url: string;
    response: unknown;
}

export class AirtableAttachmentHttpError extends Error {
    readonly status: number;
    readonly statusText: string;
    readonly url: string;
    readonly response: unknown;

    constructor(options: AirtableAttachmentHttpErrorOptions) {
        const {
            status,
            statusText,
            url,
            response,
        } = options;

        super(
            `Airtable request failed: ${status} ${statusText}`,
        );

        this.name = "AirtableAttachmentHttpError";
        this.status = status;
        this.statusText = statusText;
        this.url = url;
        this.response = response;
    }
}

type PreparedData = {
    bytes: Uint8Array;
    byteLength: number;
    dataSize: ObjectSizeReturnType;
    filename: string;
    contentType: string;
};

const MAX_ATTACHMENT_BYTES = 5 * 1024 ** 2;

const CONTENT_API_ORIGIN = "https://content.airtable.com";
const RECORD_API_ORIGIN = "https://api.airtable.com";

const DEFAULT_PRECISION = 2;
const BYTES_PER_MB = 1024 ** 2;

/**
 * Creates an Airtable attachment client.
 *
 * `apiKey` should contain an Airtable Personal Access Token.
 */
export default function airtableAttachment(
    apiKey: string,
): AirtableAttachmentModule {
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
        throw new TypeError(
            "airtableAttachment requires a non-empty Airtable API key or PAT.",
        );
    }

    const normalizedApiKey = apiKey.trim();

    async function upload<T extends ObjectOrBuffer, R = unknown>(
        data: T,
        pathOrUrl: string,
    ): Promise<AirtableAttachmentResult<T, R>> {
        const prepared = await prepareData(data);

        if (prepared.byteLength > MAX_ATTACHMENT_BYTES) {
            return {
                error: "dataTooLarge",
                dataSize: prepared.dataSize,
                data,
            };
        }

        const url = normalizeUrl(
            pathOrUrl,
            CONTENT_API_ORIGIN,
        );

        const response = await request<R>({
            apiKey: normalizedApiKey,
            url,
            method: "POST",
            body: {
                file: bytesToBase64(prepared.bytes),
                filename: prepared.filename,
                contentType: prepared.contentType,
            },
        });

        return {
            dataSize: prepared.dataSize,
            data,
            response: response.data,
            status: response.status,
        };
    }

    async function update<T extends ObjectOrBuffer, R = unknown>(
        data: T,
        pathOrUrl: string,
    ): Promise<AirtableAttachmentResult<T, R>> {
        /*
         * The direct upload endpoint appends a new attachment.
         * Airtable does not mutate an existing attachment's bytes.
         */
        return upload<T, R>(data, pathOrUrl);
    }

    async function deleteAttachment<
        T extends ObjectOrBuffer,
        R = unknown,
    >(
        data: T,
        pathOrUrl: string,
    ): Promise<AirtableAttachmentSuccess<T, R>> {
        if (isBinaryData(data)) {
            throw new TypeError(
                "delete() requires an Airtable record-update object, not binary data.",
            );
        }

        const dataSize = objectSize(data, {
            unit: "mb",
            precision: DEFAULT_PRECISION,
        });

        const url = normalizeUrl(
            pathOrUrl,
            RECORD_API_ORIGIN,
        );

        const response = await request<R>({
            apiKey: normalizedApiKey,
            url,
            method: "PATCH",
            body: data,
        });

        return {
            dataSize,
            data,
            response: response.data,
            status: response.status,
        };
    }

    return Object.freeze({
        apiKey: normalizedApiKey,
        upload,
        update,
        delete: deleteAttachment,
    });
}

async function prepareData(
    data: ObjectOrBuffer,
): Promise<PreparedData> {
    if (isBlob(data)) {
        const bytes = new Uint8Array(
            await data.arrayBuffer(),
        );

        return {
            bytes,
            byteLength: bytes.byteLength,
            dataSize: bytesToMegabytes(bytes.byteLength),
            filename: getBlobFilename(data),
            contentType:
                data.type || "application/octet-stream",
        };
    }

    if (data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(data);

        return {
            bytes,
            byteLength: bytes.byteLength,
            dataSize: bytesToMegabytes(bytes.byteLength),
            filename: "data.bin",
            contentType: "application/octet-stream",
        };
    }

    if (ArrayBuffer.isView(data)) {
        const bytes = new Uint8Array(
            data.buffer,
            data.byteOffset,
            data.byteLength,
        );

        return {
            bytes,
            byteLength: bytes.byteLength,
            dataSize: bytesToMegabytes(bytes.byteLength),
            filename: "data.bin",
            contentType: "application/octet-stream",
        };
    }

    const json = JSON.stringify(data);

    if (json === undefined) {
        throw new TypeError(
            "The supplied object cannot be serialized to JSON.",
        );
    }

    const bytes = new TextEncoder().encode(json);

    return {
        bytes,
        byteLength: bytes.byteLength,

        // This is the return type and behavior of objectSize().
        dataSize: objectSize(data, {
            unit: "mb",
            precision: DEFAULT_PRECISION,
        }),

        filename: "data.json",
        contentType: "application/json",
    };
}

function isBinaryData(
    data: ObjectOrBuffer,
): data is ArrayBuffer | ArrayBufferView | Blob {
    return (
        data instanceof ArrayBuffer ||
        ArrayBuffer.isView(data) ||
        isBlob(data)
    );
}

function isBlob(value: unknown): value is Blob {
    return (
        typeof Blob !== "undefined" &&
        value instanceof Blob
    );
}

function getBlobFilename(blob: Blob): string {
    if (
        typeof File !== "undefined" &&
        blob instanceof File &&
        blob.name
    ) {
        return blob.name;
    }

    return "data.bin";
}

function bytesToMegabytes(
    byteLength: number,
): ObjectSizeReturnType {
    return Number(
        (byteLength / BYTES_PER_MB).toFixed(
            DEFAULT_PRECISION,
        ),
    );
}

function normalizeUrl(
    pathOrUrl: string,
    defaultOrigin: string,
): string {
    if (
        typeof pathOrUrl !== "string" ||
        pathOrUrl.trim() === ""
    ) {
        throw new TypeError(
            "pathOrUrl must be a non-empty string.",
        );
    }

    const value = pathOrUrl.trim();

    if (/^https?:\/\//i.test(value)) {
        return value;
    }

    return new URL(
        value.startsWith("/") ? value : `/${value}`,
        defaultOrigin,
    ).toString();
}

function bytesToBase64(bytes: Uint8Array): string {
    const NodeBuffer = (
        globalThis as typeof globalThis & {
            Buffer?: {
                from(
                    value: ArrayBufferLike,
                    byteOffset?: number,
                    length?: number,
                ): {
                    toString(encoding: "base64"): string;
                };
            };
        }
    ).Buffer;

    if (NodeBuffer) {
        return NodeBuffer
            .from(
                bytes.buffer,
                bytes.byteOffset,
                bytes.byteLength,
            )
            .toString("base64");
    }

    if (typeof btoa !== "function") {
        throw new Error(
            "No Base64 encoder is available in this environment.",
        );
    }

    const chunkSize = 32_768;
    let binary = "";

    for (
        let offset = 0;
        offset < bytes.byteLength;
        offset += chunkSize
    ) {
        const chunk = bytes.subarray(
            offset,
            offset + chunkSize,
        );

        binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
}

async function request<R>({
    apiKey,
    url,
    method,
    body,
}: {
    apiKey: string;
    url: string;
    method: "POST" | "PATCH";
    body: unknown;
}): Promise<{
    status: number;
    data: R;
}> {
    const response = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });

    const text = await response.text();
    const responseData = parseResponseBody(text);

    if (!response.ok) {
        throw new AirtableAttachmentHttpError({
            status: response.status,
            statusText: response.statusText,
            url,
            response: responseData,
        });
    }

    return {
        status: response.status,
        data: responseData as R,
    };
}

function parseResponseBody(text: string): unknown {
    if (text === "") {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
};