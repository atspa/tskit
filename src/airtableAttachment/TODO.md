
- [ ] fix update to update attachments instead of just adding them
- [ ] add upsert method that updates or creates an attachment, based on what's needed
- [ ] if upload method path doesn't include record ID, create a new record and upload the attachment there

## Delete Method
- [ ] fix delete
E.g., this:

```ts
const upload1 = await ATT.delete(completeSpreadsheet,"appLj5Cjtoi4vkqVt/tblucqPJwoaK71aDA/recWbYZjOMIKi4H3l/Attachments")
```

Throws `AirtableAttachmentHttpError: Airtable request failed: 422 
    at async main on line 24`
    - line 24 is the one above