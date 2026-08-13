/**
 * @typedef {Object} RemoteGSheetInit
 * @property {string} spreadsheetId Google Sheets spreadsheet ID.
 * @property {string} apiKey Google API key with Sheets API access.
 * @property {string} [airtablePat] Optional Airtable personal access token reserved for companion workflows.
 * @property {typeof globalThis.fetch} [fetch] Fetch implementation. Defaults to globalThis.fetch.
 * @property {boolean} [includeGridData=true] Include CellData for all requested grid ranges.
 * @property {string[]} [ranges=[]] Optional A1 ranges to limit returned grid data.
 * @property {boolean} [excludeTablesInBandedRanges=false] Exclude tables from banded-range objects.
 */

/**
 * Lazy remote representation of a Google Spreadsheet.
 *
 * Construction performs no network request. Call `await instance.load()` to
 * fetch the Spreadsheet resource and copy all returned spreadsheet properties
 * onto the instance. `load()` returns the same instance.
 */
export class RemoteGSheet {
    /** @param {RemoteGSheetInit} init */
    constructor({
        spreadsheetId,
        apiKey,
        airtablePat,
        fetch: fetchImpl = globalThis.fetch,
        includeGridData = true,
        ranges = [],
        excludeTablesInBandedRanges = false,
    } = {}) {
        if (!spreadsheetId) {
            throw new TypeError("spreadsheetId is required");
        }

        if (!apiKey) {
            throw new TypeError("apiKey is required");
        }

        if (typeof fetchImpl !== "function") {
            throw new TypeError("fetch must be a function");
        }

        if (!Array.isArray(ranges)) {
            throw new TypeError("ranges must be an array");
        }

        this.spreadsheetId = spreadsheetId;
        this.includeGridData = includeGridData;
        this.ranges = [...ranges];
        this.excludeTablesInBandedRanges = excludeTablesInBandedRanges;
        this.loaded = false;

        // Keep credentials and the fetch implementation directly accessible
        // while preventing accidental JSON/stringification leaks.
        Object.defineProperties(this, {
            apiKey: {
                value: apiKey,
                writable: true,
                configurable: true,
                enumerable: false,
            },
            airtablePat: {
                value: airtablePat,
                writable: true,
                configurable: true,
                enumerable: false,
            },
            fetch: {
                value: fetchImpl,
                writable: true,
                configurable: true,
                enumerable: false,
            },
        });
    }

    /**
     * Fetches the remote Spreadsheet resource, loads every returned top-level
     * property onto this instance, normalizes sheets, and returns `this`.
     *
     * @param {Partial<Pick<RemoteGSheetInit, "includeGridData" | "ranges" | "excludeTablesInBandedRanges">>} [options]
     * @returns {Promise<this>}
     */
    async load(options = {}) {
        const includeGridData =
            options.includeGridData ?? this.includeGridData;
        const ranges = options.ranges ?? this.ranges;
        const excludeTablesInBandedRanges =
            options.excludeTablesInBandedRanges ??
            this.excludeTablesInBandedRanges;

        if (!Array.isArray(ranges)) {
            throw new TypeError("ranges must be an array");
        }

        const url = new URL(
            "https://sheets.googleapis.com/v4/spreadsheets/" +
                encodeURIComponent(this.spreadsheetId),
        );

        url.searchParams.set("includeGridData", String(includeGridData));
        url.searchParams.set(
            "excludeTablesInBandedRanges",
            String(excludeTablesInBandedRanges),
        );

        for (const range of ranges) {
            url.searchParams.append("ranges", range);
        }

        const response = await this.fetch(url.toString(), {
            method: "GET",
            headers: {
                Accept: "application/json",
                "x-goog-api-key": this.apiKey,
            },
        });

        const responseText = await response.text();
        let payload;

        try {
            payload = responseText ? JSON.parse(responseText) : {};
        } catch {
            throw new Error(
                `Google Sheets API returned invalid JSON ` +
                    `(${response.status} ${response.statusText}): ${responseText}`,
            );
        }

        if (!response.ok) {
            const googleError = isJsonObject(payload?.error)
                ? payload.error
                : undefined;
            const message =
                typeof googleError?.message === "string"
                    ? googleError.message
                    : responseText;

            throw new Error(
                `Google Sheets API request failed ` +
                    `(${response.status} ${response.statusText}): ${message}`,
            );
        }

        if (!isJsonObject(payload)) {
            throw new Error("Google Sheets API returned a non-object payload");
        }

        const normalized = normalizeGSpreadsheet(payload);

        // Preserve every top-level property returned by Google, then overlay
        // the convenience aliases and normalized sheet objects.
        Object.assign(this, payload, normalized, {
            includeGridData,
            ranges: [...ranges],
            excludeTablesInBandedRanges,
            loaded: true,
        });

        return this;
    }

    /** Whether an Airtable PAT was supplied without exposing the token itself. */
    get hasAirtablePat() {
        return typeof this.airtablePat === "string" && this.airtablePat.length > 0;
    }
}

/**
 * Create an unloaded RemoteGSheet instance.
 *
 * @param {RemoteGSheetInit} init
 * @returns {RemoteGSheet}
 */
export function remoteGsheet(init) {
    return new RemoteGSheet(init);
}

/**
 * Backward-compatible eager helper. Returns a loaded RemoteGSheet instance.
 *
 * @param {RemoteGSheetInit} init
 * @returns {Promise<RemoteGSheet>}
 */
export async function fetchGSheetSchema(init) {
    return remoteGsheet(init).load();
}

export default remoteGsheet;

function normalizeGSpreadsheet(payload) {
    const {
        spreadsheetId,
        spreadsheetUrl,
        properties: rawProperties,
        sheets: rawSheets,
        namedRanges,
        developerMetadata,
        dataSources,
        dataSourceSchedules,
        ...additionalGoogleFields
    } = payload;

    const properties = isJsonObject(rawProperties) ? rawProperties : {};

    const sheets = Array.isArray(rawSheets)
        ? rawSheets
              .filter(isJsonObject)
              .map(normalizeGSheet)
              .sort((a, b) => {
                  return (
                      (a.index ?? Number.MAX_SAFE_INTEGER) -
                      (b.index ?? Number.MAX_SAFE_INTEGER)
                  );
              })
        : [];

    return {
        ...additionalGoogleFields,
        type: "GSpreadsheet",
        id: typeof spreadsheetId === "string" ? spreadsheetId : "",
        title: typeof properties.title === "string" ? properties.title : "",
        url: typeof spreadsheetUrl === "string" ? spreadsheetUrl : null,
        properties,
        sheets,
        namedRanges: toObjectArray(namedRanges),
        developerMetadata: toObjectArray(developerMetadata),
        dataSources: toObjectArray(dataSources),
        dataSourceSchedules: toObjectArray(dataSourceSchedules),
    };
}

function normalizeGSheet(sheet) {
    const properties = isJsonObject(sheet.properties) ? sheet.properties : {};

    return {
        type: "GSheet",
        id: typeof properties.sheetId === "number" ? properties.sheetId : null,
        title: typeof properties.title === "string" ? properties.title : "",
        index: typeof properties.index === "number" ? properties.index : null,
        ...sheet,
        properties,
    };
}

function toObjectArray(value) {
    return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
