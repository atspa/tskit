export type JsonObject = Record<string, unknown>;

export type GSheet = JsonObject & {
    type: "GSheet";
    id: number | null;
    title: string;
    index: number | null;
};

export type GSpreadsheet = JsonObject & {
    type: "GSpreadsheet";
    id: string;
    title: string;
    url: string | null;

    properties: JsonObject;
    sheets: GSheet[];

    namedRanges: JsonObject[];
    developerMetadata: JsonObject[];
    dataSources: JsonObject[];
    dataSourceSchedules: JsonObject[];
};

export type FetchGSheetSchenaOptions = {
    spreadsheetId: string;
    apiKey: string;

    /**
     * Includes cell values, formulas, formatting, notes, hyperlinks,
     * data validation, effective values, and other CellData.
     *
     * This can produce a very large response.
     */
    includeGridData?: boolean;

    /**
     * Optional A1 ranges. Only relevant when includeGridData is true.
     *
     * Examples:
     *   ["Xbox Game Pass"]
     *   ["Xbox Game Pass!A1:Z5000", "PlayStation Plus!A1:Z5000"]
     */
    ranges?: string[];

    /**
     * Whether tables should be excluded from banded-range objects.
     */
    excludeTablesInBandedRanges?: boolean;
};

export async function fetchGSheetSchena({
    spreadsheetId,
    apiKey,
    includeGridData = false,
    ranges = [],
    excludeTablesInBandedRanges = false,
}: FetchGSheetSchenaOptions): Promise<GSpreadsheet> {
    if (!spreadsheetId) {
        throw new TypeError("spreadsheetId is required");
    }

    if (!apiKey) {
        throw new TypeError("apiKey is required");
    }

    const url = new URL(
        `https://sheets.googleapis.com/v4/spreadsheets/` +
        encodeURIComponent(spreadsheetId),
    );

    url.searchParams.set("includeGridData", String(includeGridData));

    url.searchParams.set(
        "excludeTablesInBandedRanges",
        String(excludeTablesInBandedRanges),
    );

    for (const range of ranges) {
        url.searchParams.append("ranges", range);
    }

    /*
     * Deliberately do not set `fields`.
     *
     * Omitting a field mask asks Google for the complete Spreadsheet
     * resource available for this request. A field mask would also make
     * includeGridData ineffective as a query parameter.
     */
    const response = await fetch(url, {
        method: "GET",
        headers: {
            Accept: "application/json",
            "x-goog-api-key": apiKey,
        },
    });

    const responseText = await response.text();

    let payload: JsonObject;

    try {
        payload = responseText ? JSON.parse(responseText) : {};
    } catch {
        throw new Error(
            `Google Sheets API returned invalid JSON ` +
            `(${response.status} ${response.statusText}): ${responseText}`,
        );
    }

    if (!response.ok) {
        const googleError = payload.error as JsonObject | undefined;
        const message =
            typeof googleError?.message === "string"
                ? googleError.message
                : responseText;

        throw new Error(
            `Google Sheets API request failed ` +
            `(${response.status} ${response.statusText}): ${message}`,
        );
    }

    return normalizeGSpreadsheet(payload);
}

export default fetchGSheetSchena;

function normalizeGSpreadsheet(payload: JsonObject): GSpreadsheet {
    const {
        spreadsheetId,
        spreadsheetUrl,
        properties: rawProperties,
        sheets: rawSheets,
        namedRanges,
        developerMetadata,
        dataSources,
        dataSourceSchedules,

        // Preserve any fields Google adds to the API later.
        ...additionalGoogleFields
    } = payload;

    const properties = isJsonObject(rawProperties) ? rawProperties : {};

    const sheets = Array.isArray(rawSheets)
        ? rawSheets
            .filter(isJsonObject)
            .map(normalizeGSheet)
            .sort((a, b) => {
                return (a.index ?? Number.MAX_SAFE_INTEGER) -
                    (b.index ?? Number.MAX_SAFE_INTEGER);
            })
        : [];

    return {
        type: "GSpreadsheet",

        id:
            typeof spreadsheetId === "string"
                ? spreadsheetId
                : "",

        title:
            typeof properties.title === "string"
                ? properties.title
                : "",

        url:
            typeof spreadsheetUrl === "string"
                ? spreadsheetUrl
                : null,

        properties,
        sheets,

        namedRanges: toObjectArray(namedRanges),
        developerMetadata: toObjectArray(developerMetadata),
        dataSources: toObjectArray(dataSources),
        dataSourceSchedules: toObjectArray(dataSourceSchedules),

        ...additionalGoogleFields,
    };
}

function normalizeGSheet(sheet: JsonObject): GSheet {
    const properties = isJsonObject(sheet.properties)
        ? sheet.properties
        : {};

    return {
        type: "GSheet",

        id:
            typeof properties.sheetId === "number"
                ? properties.sheetId
                : null,

        title:
            typeof properties.title === "string"
                ? properties.title
                : "",

        index:
            typeof properties.index === "number"
                ? properties.index
                : null,

        // Retains every raw Sheet field returned by Google.
        ...sheet,

        // Ensure this is always a normalized object.
        properties,
    };
}

function toObjectArray(value: unknown): JsonObject[] {
    return Array.isArray(value)
        ? value.filter(isJsonObject)
        : [];
}

function isJsonObject(value: unknown): value is JsonObject {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
    );
};