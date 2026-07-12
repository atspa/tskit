import { argv, argv0, cwd } from "node:process";
import { fetchGSheetSchena } from "../index.ts";

/** inline args */
const iArgs = argv.slice(2)
const tokenIndex = iArgs.findIndex(str => ['token', 'key', 'apikey'].includes(str.toLowerCase().replace(/^[\-]+/, '')));
const TOKEN = iArgs[tokenIndex + 1]

if (!TOKEN || typeof TOKEN !== 'string') {

    console.error({ iArgs, TOKEN });
    throw `Google Cloud API key not found.`
};


const schema = await fetchGSheetSchena({
    spreadsheetId:
        "1kspw-4paT-eE5-mrCrc4R9tg70lH2ZTFrJOUmOtOytg",
    apiKey: TOKEN,
});

const schemaString = JSON.stringify(schema, null, 2);

console.log({ schema, ssLen: schemaString.length });



export { schema, schemaString };
