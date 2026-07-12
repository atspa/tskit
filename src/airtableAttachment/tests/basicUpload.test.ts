import airtableAttachment from "../index.ts";

const attachments = airtableAttachment(
    process.env.AIRTABLE_PAT!,
);

const result = await attachments.upload(
    {
        type: "GSpreadsheet",
        id: "spreadsheet-id",
        sheets: [],
    },
    "/v0/appXXXXXXXXXXXXXX/recXXXXXXXXXXXXXX/fldXXXXXXXXXXXXXX/uploadAttachment",
);

if ("error" in result) {
    console.log(result);
} else {
    console.log(result.status);
    console.log(result.response);
}