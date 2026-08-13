// @ts-expect-error remoteGsheet is intentionally shipped as a standalone MJS module.
import remoteGsheet, {
    RemoteGSheet,
    fetchGSheetSchema,
} from "./remoteGsheet.mjs";
import { objectSize } from "./objectSize/index.ts";
import airtableAttachment from "./airtableAttachment/index.ts";
import parseCsv from "./parse-csv/index.ts";
import extractLinks from "./extract-links/index.ts";
import Unarchive from "./unarchive/index.ts";

export {
    remoteGsheet,
    RemoteGSheet,
    fetchGSheetSchema,
    objectSize,
    airtableAttachment,
    parseCsv,
    extractLinks,
    Unarchive,
};

export default {
    remoteGsheet,
    RemoteGSheet,
    fetchGSheetSchema,
    objectSize,
    airtableAttachment,
    parseCsv,
    extractLinks,
    Unarchive,
};
