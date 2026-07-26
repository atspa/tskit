/**
 * Environment-agnostic ZIP/GZIP archive loader.
 *
 * Dependency resolution:
 *   1. Per-call `init.fflate`
 *   2. Cached `Unarchive.fflate`
 *   3. Installed `fflate` package when running in Node.js
 *   4. esm.sh fallback
 *
 * In Node.js, the esm.sh fallback is fetched as a standalone bundle and
 * imported through a data URL because Node does not natively import HTTPS
 * module specifiers.
 */

export type ArchiveType = 'zip' | 'gzip';

export interface RequestLike {
    readonly url: string;
}

export type ArchiveSource = string | RequestLike;

export interface HeadersLike {
    get(name: string): string | null;
}

export interface ResponseLike {
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    readonly url?: string;
    readonly headers?: HeadersLike | Record<string, unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
    text?(): Promise<string>;
}

export type FetchMethod = (
    input: ArchiveSource,
    init?: unknown
) => Promise<ResponseLike>;

export interface TextDecoderLike {
    decode(input?: Uint8Array): string;
}

export type ZipFileMap = Record<string, Uint8Array>;

export type ArchiveCallback<T> = (
    error: unknown,
    result?: T
) => void;

/**
 * Compatible with fflate's asynchronous methods as well as custom synchronous
 * or Promise-based methods.
 */
export type ArchiveMethod<T> = (
    bytes: Uint8Array,
    callback?: ArchiveCallback<T>
) => T | Promise<T> | (() => void) | void;

export interface FflateModule {
    unzip?: ArchiveMethod<ZipFileMap>;
    gunzip?: ArchiveMethod<Uint8Array>;
    default?: {
        unzip?: ArchiveMethod<ZipFileMap>;
        gunzip?: ArchiveMethod<Uint8Array>;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

export interface UnarchiveInit {
    /**
     * Explicit archive type. When omitted, the type is inferred from the file
     * signature, response headers, and URL. Defaults to ZIP if inference fails.
     */
    archiveType?: ArchiveType;

    /**
     * Per-call fflate dependency override. Supplying this prevents class-level
     * dependency resolution for this call.
     */
    fflate?: FflateModule | Promise<FflateModule>;

    /** Per-call fetch implementation override. */
    fetchMethod?: FetchMethod;

    /** Optional init object passed to the selected fetch method. */
    requestInit?: unknown;

    /** Per-call ZIP decompression method override. */
    unzipMethod?: ArchiveMethod<ZipFileMap>;

    /** Per-call GZIP decompression method override. */
    gunzipMethod?: ArchiveMethod<Uint8Array>;

    /**
     * Output key for a decompressed GZIP stream. By default, it is inferred
     * from Content-Disposition or the response/request URL.
     */
    gzipFilename?: string;

    /** Per-call text decoder override. */
    decoder?: TextDecoderLike;
}

interface RuntimeGlobals {
    fetch?: FetchMethod;
    TextDecoder?: new (label?: string) => TextDecoderLike;
    URL?: new (input: string, base?: string) => { href: string };
    process?: {
        release?: { name?: string };
        versions?: {
            node?: string;
            bun?: string;
            [key: string]: string | undefined;
        };
    };
    Deno?: unknown;
    Bun?: unknown;
}

interface DecodeZipInput {
    bytes: Uint8Array;
    method: ArchiveMethod<ZipFileMap>;
    decoder: TextDecoderLike;
}

interface DecodeGzipInput {
    bytes: Uint8Array;
    method: ArchiveMethod<Uint8Array>;
    decoder: TextDecoderLike;
    response: ResponseLike;
    requestUrl: string;
    gzipFilename?: string;
}

interface InferArchiveTypeInput {
    bytes: Uint8Array;
    response: ResponseLike;
    requestUrl: string;
}

interface RemoteModuleSource {
    source: string;
    url: string;
}

export class Unarchive {
    /**
     * esm.sh module URL used when no injected or locally installed fflate
     * dependency is available.
     */
    static fflateURL =
        'https://esm.sh/fflate?standalone&target=es2022';

    /**
     * Cached fflate module or in-flight dependency-resolution Promise.
     *
     * This may also be assigned manually:
     *
     *     Unarchive.fflate = await import('fflate');
     */
    static fflate: FflateModule | Promise<FflateModule> | null = null;

    /** Default fetch implementation, when the runtime exposes one. */
    static fetchMethod: FetchMethod | null =
        Unarchive.getGlobalFetch();

    /** Default UTF-8 decoder, when the runtime exposes TextDecoder. */
    static decoder: TextDecoderLike | null =
        Unarchive.createDefaultDecoder();

    /** Archive type used when inference is inconclusive. */
    static defaultArchiveType: ArchiveType = 'zip';

    private constructor() {
        throw new TypeError(
            'Unarchive is a static utility class and cannot be instantiated.'
        );
    }

    /**
     * Fetches and decompresses a remote ZIP or GZIP archive.
     *
     * ZIP archives return one property per archived file. GZIP streams return
     * one property containing the decompressed stream.
     */
    static async load(
        source: ArchiveSource,
        init: UnarchiveInit = {}
    ): Promise<Record<string, string>> {
        const fetchMethod = init.fetchMethod ?? this.fetchMethod;

        if (typeof fetchMethod !== 'function') {
            throw new TypeError(
                'fetchMethod is required because no default fetch implementation is available.'
            );
        }

        this.validateArchiveType(init.archiveType);

        const requestUrl = this.getRequestUrl(source);

        // Fetch first so a failed archive request does not load fflate.
        const response = await fetchMethod(source, init.requestInit);

        this.assertSuccessfulResponse(response, requestUrl || 'archive');

        if (typeof response.arrayBuffer !== 'function') {
            throw new TypeError(
                'fetchMethod must return a Response-like object with an arrayBuffer() method.'
            );
        }

        const bytes = new Uint8Array(await response.arrayBuffer());

        const archiveType =
            init.archiveType ??
            this.inferArchiveType({
                bytes,
                response,
                requestUrl
            });

        const decoder = init.decoder ?? this.decoder;

        if (!decoder || typeof decoder.decode !== 'function') {
            throw new TypeError(
                'A TextDecoder-compatible instance must be supplied through Unarchive.decoder or init.decoder.'
            );
        }

        try {
            if (archiveType === 'gzip') {
                const method = await this.resolveGzipMethod(init);

                return await this.decodeGzip({
                    bytes,
                    method,
                    decoder,
                    response,
                    requestUrl,
                    gzipFilename: init.gzipFilename
                });
            }

            const method = await this.resolveZipMethod(init);

            return await this.decodeZip({
                bytes,
                method,
                decoder
            });
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : String(error);

            const wrapped = new Error(
                `Failed to decompress ${archiveType.toUpperCase()} archive: ${message}`
            );

            (wrapped as Error & { cause?: unknown }).cause = error;

            throw wrapped;
        }
    }

    /** Alias for Unarchive.load(). */
    static from(
        source: ArchiveSource,
        init: UnarchiveInit = {}
    ): Promise<Record<string, string>> {
        return this.load(source, init);
    }

    /**
     * Loads and caches fflate.
     *
     * Resolution order:
     *   - installed `fflate` package in Node.js
     *   - esm.sh fallback
     *
     * A failed resolution clears the cache so a later call may retry.
     */
    static loadFflate(): Promise<FflateModule> {
        if (this.fflate) {
            return Promise.resolve(this.fflate);
        }

        const pending = this.resolveFflateDependency()
            .then(module => {
                if (this.fflate === pending) {
                    this.fflate = module;
                }

                return module;
            })
            .catch(error => {
                if (this.fflate === pending) {
                    this.fflate = null;
                }

                throw error;
            });

        this.fflate = pending;

        return pending;
    }

    /** Clears the cached module or pending dependency-resolution Promise. */
    static clearFflateCache(): void {
        this.fflate = null;
    }

    /** Returns true only for Node.js, excluding Bun and Deno compatibility. */
    static isNodeRuntime(): boolean {
        const globals = globalThis as unknown as RuntimeGlobals;
        const versions = globals.process?.versions;

        return Boolean(
            versions?.node &&
            !versions.bun &&
            globals.Deno === undefined &&
            globals.Bun === undefined
        );
    }

    private static async resolveFflateDependency(): Promise<FflateModule> {
        if (this.isNodeRuntime()) {
            const installed = await this.tryImportInstalledFflate();

            if (installed) {
                return installed;
            }

            return this.importFflateFromEsmShInNode();
        }

        return this.normalizeFflateModule(
            await this.importModule(this.fflateURL)
        );
    }

    /**
     * Attempts to resolve the optional local Node dependency without causing
     * TypeScript or bundlers to require it at build time.
     */
    private static async tryImportInstalledFflate(): Promise<FflateModule | null> {
        try {
            return this.normalizeFflateModule(
                await this.importModule('fflate')
            );
        } catch (error) {
            if (this.isMissingPackageError(error, 'fflate')) {
                return null;
            }

            throw new Error(
                `The installed fflate package could not be loaded: ${this.getErrorMessage(error)}`,
                { cause: error }
            );
        }
    }

    /**
     * Node.js does not natively import HTTPS module specifiers. Fetch the
     * standalone esm.sh bundle, convert it to a data URL, then import it.
     */
    private static async importFflateFromEsmShInNode(): Promise<FflateModule> {
        const remote = await this.fetchRemoteModuleSource(this.fflateURL);
        const sourceUrlComment = remote.url.replace(/[\r\n]/g, '');
        const source = `${remote.source}\n//# sourceURL=${sourceUrlComment}`;
        const dataUrl =
            `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;

        try {
            return this.normalizeFflateModule(
                await this.importModule(dataUrl)
            );
        } catch (error) {
            throw new Error(
                `Failed to import the esm.sh fflate fallback: ${this.getErrorMessage(error)}`,
                { cause: error }
            );
        }
    }

    /**
     * Fetches an esm.sh entrypoint. When esm.sh exposes its built module through
     * X-ESM-Path, this follows that path so the imported data URL contains the
     * actual standalone module rather than a re-exporting entry stub.
     */
    private static async fetchRemoteModuleSource(
        url: string
    ): Promise<RemoteModuleSource> {
        const first = await this.fetchTextResponse(url);
        const esmPath = this.getHeader(first.response, 'x-esm-path');

        if (!esmPath) {
            return {
                source: first.text,
                url: first.response.url || url
            };
        }

        const resolvedUrl = this.resolveUrl(
            esmPath,
            first.response.url || url
        );

        if (resolvedUrl === first.response.url || resolvedUrl === url) {
            return {
                source: first.text,
                url: first.response.url || url
            };
        }

        const second = await this.fetchTextResponse(resolvedUrl);

        return {
            source: second.text,
            url: second.response.url || resolvedUrl
        };
    }

    private static async fetchTextResponse(
        url: string
    ): Promise<{ response: ResponseLike; text: string }> {
        const fetchMethod = this.fetchMethod ?? this.getGlobalFetch();

        if (typeof fetchMethod !== 'function') {
            throw new TypeError(
                'The esm.sh fallback requires a fetch implementation. Set Unarchive.fetchMethod before loading an archive.'
            );
        }

        const response = await fetchMethod(url);

        this.assertSuccessfulResponse(response, url);

        if (typeof response.text === 'function') {
            return {
                response,
                text: await response.text()
            };
        }

        if (typeof response.arrayBuffer !== 'function') {
            throw new TypeError(
                'The fetch implementation returned no text() or arrayBuffer() method.'
            );
        }

        const decoder = this.decoder ?? this.createDefaultDecoder();

        if (!decoder) {
            throw new TypeError(
                'A TextDecoder-compatible implementation is required to load the esm.sh fallback.'
            );
        }

        return {
            response,
            text: decoder.decode(
                new Uint8Array(await response.arrayBuffer())
            )
        };
    }

    /**
     * Keeps optional package and remote URL imports runtime-resolved.
     * `@vite-ignore` prevents Vite from attempting to pre-bundle the variable
     * specifier.
     */
    private static importModule(specifier: string): Promise<unknown> {
        return import(/* @vite-ignore */ specifier);
    }

    private static normalizeFflateModule(value: unknown): FflateModule {
        if (!value || typeof value !== 'object') {
            throw new TypeError(
                'The resolved fflate dependency is not a module object.'
            );
        }

        const module = value as FflateModule;

        if (
            typeof module.unzip !== 'function' &&
            typeof module.default?.unzip !== 'function'
        ) {
            throw new TypeError(
                'The resolved dependency does not expose fflate.unzip.'
            );
        }

        if (
            typeof module.gunzip !== 'function' &&
            typeof module.default?.gunzip !== 'function'
        ) {
            throw new TypeError(
                'The resolved dependency does not expose fflate.gunzip.'
            );
        }

        return module;
    }

    private static async resolveZipMethod(
        init: UnarchiveInit
    ): Promise<ArchiveMethod<ZipFileMap>> {
        if (init.unzipMethod !== undefined) {
            if (typeof init.unzipMethod !== 'function') {
                throw new TypeError('unzipMethod must be a function.');
            }

            return init.unzipMethod;
        }

        const fflate = await this.resolveCallFflate(init);
        const method = fflate.unzip ?? fflate.default?.unzip;

        if (typeof method !== 'function') {
            throw new Error('Failed to resolve fflate.unzip.');
        }

        return method;
    }

    private static async resolveGzipMethod(
        init: UnarchiveInit
    ): Promise<ArchiveMethod<Uint8Array>> {
        if (init.gunzipMethod !== undefined) {
            if (typeof init.gunzipMethod !== 'function') {
                throw new TypeError('gunzipMethod must be a function.');
            }

            return init.gunzipMethod;
        }

        const fflate = await this.resolveCallFflate(init);
        const method = fflate.gunzip ?? fflate.default?.gunzip;

        if (typeof method !== 'function') {
            throw new Error('Failed to resolve fflate.gunzip.');
        }

        return method;
    }

    private static async resolveCallFflate(
        init: UnarchiveInit
    ): Promise<FflateModule> {
        return init.fflate !== undefined
            ? this.normalizeFflateModule(await init.fflate)
            : this.loadFflate();
    }

    private static async decodeZip({
        bytes,
        method,
        decoder
    }: DecodeZipInput): Promise<Record<string, string>> {
        const files = await this.invokeArchiveMethod(method, bytes);

        if (
            !files ||
            typeof files !== 'object' ||
            files instanceof ArrayBuffer ||
            ArrayBuffer.isView(files)
        ) {
            throw new TypeError(
                'The ZIP decompression method did not return a file map.'
            );
        }

        const decoded: Record<string, string> = {};

        for (const [filename, contents] of Object.entries(files)) {
            decoded[filename] = decoder.decode(
                this.toUint8Array(contents)
            );
        }

        return decoded;
    }

    private static async decodeGzip({
        bytes,
        method,
        decoder,
        response,
        requestUrl,
        gzipFilename
    }: DecodeGzipInput): Promise<Record<string, string>> {
        const decompressed = this.toUint8Array(
            await this.invokeArchiveMethod(method, bytes)
        );

        const filename =
            gzipFilename ??
            this.inferGzipFilename(response, requestUrl);

        return {
            [filename]: decoder.decode(decompressed)
        };
    }

    /**
     * Supports callback-based, synchronous, and Promise-based methods.
     * Function return values are ignored because asynchronous fflate methods
     * return cancellation handles rather than decompressed data.
     */
    private static invokeArchiveMethod<T>(
        method: ArchiveMethod<T>,
        bytes: Uint8Array
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let settled = false;

            const finish: ArchiveCallback<T> = (error, result) => {
                if (settled) {
                    return;
                }

                settled = true;

                if (error) {
                    reject(
                        error instanceof Error
                            ? error
                            : new Error(String(error))
                    );
                    return;
                }

                if (result === undefined) {
                    reject(
                        new TypeError(
                            'The decompression method completed without returning data.'
                        )
                    );
                    return;
                }

                resolve(result);
            };

            try {
                const result = method(bytes, finish);

                if (this.isPromiseLike<T>(result)) {
                    result.then(
                        value => finish(null, value),
                        error => finish(error)
                    );
                    return;
                }

                if (
                    result !== undefined &&
                    typeof result !== 'function'
                ) {
                    finish(null, result as T);
                }
            } catch (error) {
                finish(error);
            }
        });
    }

    private static isPromiseLike<T>(
        value: unknown
    ): value is PromiseLike<T> {
        return Boolean(
            value &&
            (
                typeof value === 'object' ||
                typeof value === 'function'
            ) &&
            typeof (value as PromiseLike<T>).then === 'function'
        );
    }

    private static inferArchiveType({
        bytes,
        response,
        requestUrl
    }: InferArchiveTypeInput): ArchiveType {
        if (this.hasGzipMagic(bytes)) {
            return 'gzip';
        }

        if (this.hasZipMagic(bytes)) {
            return 'zip';
        }

        const contentType = this.getHeader(response, 'content-type')
            ?.split(';', 1)[0]
            .trim()
            .toLowerCase();

        if (
            contentType === 'application/gzip' ||
            contentType === 'application/x-gzip'
        ) {
            return 'gzip';
        }

        if (
            contentType === 'application/zip' ||
            contentType === 'application/x-zip-compressed'
        ) {
            return 'zip';
        }

        const dispositionFilename =
            this.getContentDispositionFilename(
                this.getHeader(response, 'content-disposition')
            );

        for (const candidate of [
            dispositionFilename,
            response.url,
            requestUrl
        ]) {
            const inferred = this.inferArchiveTypeFromName(candidate);

            if (inferred) {
                return inferred;
            }
        }

        return this.defaultArchiveType;
    }

    private static hasGzipMagic(bytes: Uint8Array): boolean {
        return (
            bytes.length >= 2 &&
            bytes[0] === 0x1f &&
            bytes[1] === 0x8b
        );
    }

    private static hasZipMagic(bytes: Uint8Array): boolean {
        if (
            bytes.length < 4 ||
            bytes[0] !== 0x50 ||
            bytes[1] !== 0x4b
        ) {
            return false;
        }

        return (
            (bytes[2] === 0x03 && bytes[3] === 0x04) ||
            (bytes[2] === 0x05 && bytes[3] === 0x06) ||
            (bytes[2] === 0x07 && bytes[3] === 0x08)
        );
    }

    private static inferArchiveTypeFromName(
        value: string | null | undefined
    ): ArchiveType | undefined {
        if (!value) {
            return undefined;
        }

        const pathname = value
            .split('#', 1)[0]
            .split('?', 1)[0]
            .toLowerCase();

        if (
            pathname.endsWith('.gz') ||
            pathname.endsWith('.gzip') ||
            pathname.endsWith('.tgz')
        ) {
            return 'gzip';
        }

        return pathname.endsWith('.zip')
            ? 'zip'
            : undefined;
    }

    private static inferGzipFilename(
        response: ResponseLike,
        requestUrl: string
    ): string {
        const dispositionFilename =
            this.getContentDispositionFilename(
                this.getHeader(response, 'content-disposition')
            );

        const filename =
            dispositionFilename ||
            this.getUrlFilename(response.url) ||
            this.getUrlFilename(requestUrl) ||
            'archive.gz';

        return this.stripGzipExtension(filename) || 'archive';
    }

    private static stripGzipExtension(filename: string): string {
        if (/\.tar\.gz$/i.test(filename)) {
            return filename.replace(/\.gz$/i, '');
        }

        if (/\.tgz$/i.test(filename)) {
            return filename.replace(/\.tgz$/i, '.tar');
        }

        return filename.replace(/\.(?:gz|gzip)$/i, '');
    }

    private static getHeader(
        response: ResponseLike,
        name: string
    ): string | null {
        const headers = response.headers;

        if (!headers) {
            return null;
        }

        if (typeof (headers as HeadersLike).get === 'function') {
            return (headers as HeadersLike).get(name);
        }

        const normalizedName = name.toLowerCase();
        const record = headers as Record<string, unknown>;
        const matchingKey = Object.keys(record).find(
            key => key.toLowerCase() === normalizedName
        );

        if (matchingKey === undefined) {
            return null;
        }

        const value = record[matchingKey];

        return value == null ? null : String(value);
    }

    private static getContentDispositionFilename(
        header: string | null | undefined
    ): string {
        if (!header) {
            return '';
        }

        const encodedMatch = header.match(
            /(?:^|;)\s*filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i
        );

        if (encodedMatch) {
            const value = encodedMatch[1]
                .trim()
                .replace(/^"|"$/g, '');

            try {
                return decodeURIComponent(value);
            } catch {
                return value;
            }
        }

        const regularMatch = header.match(
            /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i
        );

        return (
            regularMatch?.[1] ??
            regularMatch?.[2]?.trim() ??
            ''
        );
    }

    private static getRequestUrl(source: ArchiveSource): string {
        return typeof source === 'string'
            ? source
            : typeof source?.url === 'string'
                ? source.url
                : '';
    }

    private static getUrlFilename(
        value: string | null | undefined
    ): string {
        if (!value) {
            return '';
        }

        const pathname = value
            .split('#', 1)[0]
            .split('?', 1)[0];

        const filename = pathname.slice(
            pathname.lastIndexOf('/') + 1
        );

        try {
            return decodeURIComponent(filename);
        } catch {
            return filename;
        }
    }

    private static resolveUrl(value: string, base: string): string {
        const URLConstructor = (
            globalThis as unknown as RuntimeGlobals
        ).URL;

        if (URLConstructor) {
            return new URLConstructor(value, base).href;
        }

        if (/^https?:\/\//i.test(value)) {
            return value;
        }

        const originMatch = base.match(/^(https?:\/\/[^/]+)/i);

        if (value.startsWith('/') && originMatch) {
            return `${originMatch[1]}${value}`;
        }

        const baseDirectory = base.replace(/[^/]*(?:[?#].*)?$/, '');

        return `${baseDirectory}${value}`;
    }

    private static toUint8Array(value: unknown): Uint8Array {
        if (value instanceof Uint8Array) {
            return value;
        }

        if (value instanceof ArrayBuffer) {
            return new Uint8Array(value);
        }

        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(
                value.buffer,
                value.byteOffset,
                value.byteLength
            );
        }

        throw new TypeError(
            'The decompression method did not return binary data.'
        );
    }

    private static validateArchiveType(
        archiveType: ArchiveType | undefined
    ): void {
        if (
            archiveType !== undefined &&
            archiveType !== 'zip' &&
            archiveType !== 'gzip'
        ) {
            throw new TypeError(
                `archiveType must be "zip" or "gzip"; received ${JSON.stringify(archiveType)}.`
            );
        }
    }

    private static assertSuccessfulResponse(
        response: ResponseLike | null | undefined,
        target: string
    ): asserts response is ResponseLike {
        if (response?.ok) {
            return;
        }

        const status = response
            ? `${response.status} ${response.statusText}`.trim()
            : 'no response';

        throw new Error(`Failed to fetch ${target}: ${status}`);
    }

    private static getGlobalFetch(): FetchMethod | null {
        const candidate = (
            globalThis as unknown as RuntimeGlobals
        ).fetch;

        return typeof candidate === 'function'
            ? candidate.bind(globalThis)
            : null;
    }

    private static createDefaultDecoder(): TextDecoderLike | null {
        const Decoder = (
            globalThis as unknown as RuntimeGlobals
        ).TextDecoder;

        return typeof Decoder === 'function'
            ? new Decoder('utf-8')
            : null;
    }

    private static isMissingPackageError(
        error: unknown,
        packageName: string
    ): boolean {
        if (!error || typeof error !== 'object') {
            return false;
        }

        const candidate = error as {
            code?: unknown;
            message?: unknown;
        };

        const code = String(candidate.code ?? '');
        const message = String(candidate.message ?? '');

        return (
            code === 'ERR_MODULE_NOT_FOUND' ||
            code === 'MODULE_NOT_FOUND' ||
            message.includes(`Cannot find package '${packageName}'`) ||
            message.includes(`Cannot find module '${packageName}'`) ||
            message.includes(`Cannot find package \"${packageName}\"`) ||
            message.includes(`Cannot find module \"${packageName}\"`)
        );
    }

    private static getErrorMessage(error: unknown): string {
        return error instanceof Error
            ? error.message
            : String(error);
    }
}

export default Unarchive;
