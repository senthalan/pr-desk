// Validates pr-desk.config.json without calling GitHub, and regenerates the
// JSON Schema that editors use for autocomplete.
//
//   npm run check-config            validate
//   npm run check-config -- --schema  also rewrite pr-desk.config.schema.json

import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { ConfigSchema, parseConfig } from "../src/lib/config";

const file = process.env.PR_DESK_CONFIG ?? "pr-desk.config.json";

async function main() {
  if (process.argv.includes("--schema")) {
    const schema: any = z.toJSONSchema(ConfigSchema, { io: "input" });
    schema.title = "pr-desk configuration";
    schema.properties = { $schema: { type: "string" }, ...schema.properties };
    await writeFile("pr-desk.config.schema.json", JSON.stringify(schema, null, 2) + "\n");
    console.log("Wrote pr-desk.config.schema.json");
  }
  try {
    const config = parseConfig(JSON.parse(await readFile(file, "utf8")));
    const members = config.groups.reduce((n, g) => n + g.members.length, 0);
    console.log(
      `${file} is valid: ${config.repos.length} repo(s), ${config.groups.length} group(s) with ${members} pinned member(s), ` +
        `timezone ${config.businessDays.timezone}.`,
    );
  } catch (e: any) {
    if (e instanceof z.ZodError) {
      console.error(`${file} is invalid:`);
      for (const issue of e.issues) console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    } else {
      console.error(`${file} is invalid: ${e?.message ?? e}`);
    }
    process.exit(1);
  }
}

main();
