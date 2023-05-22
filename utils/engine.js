import { emptyDir, exists } from "https://deno.land/std@0.119.0/fs/mod.ts";
import { copy } from "https://deno.land/std@0.119.0/fs/copy.ts";
import { load } from "https://deno.land/x/js_yaml_port@3.14.0/js-yaml.js";

const baseUrl = "https://spec.utxo.cz";

const banner = `
██╗░░░██╗████████╗██╗░░██╗░█████╗░
██║░░░██║╚══██╔══╝╚██╗██╔╝██╔══██╗
██║░░░██║░░░██║░░░░╚███╔╝░██║░░██║
██║░░░██║░░░██║░░░░██╔██╗░██║░░██║
╚██████╔╝░░░██║░░░██╔╝╚██╗╚█████╔╝
░╚═════╝░░░░╚═╝░░░╚═╝░░╚═╝░╚════╝░
`;

export class UTXOEngine {
  constructor(options = {}) {
    this.options = options;
    this.defaultSchemaVersion = "1";
    this.srcDir = this.options.srcDir || "./spec";
    if (!this.options.silent) {
      console.log(banner);
    }
    this.imageTypes = [
      ["web", "svg"],
      ["web", "png"],
      ["web", "webp"],
      ["web", "jpg"],
      ["sm", "png"],
      ["sm", "webp"],
      ["twitter", "jpg"],
    ];
  }

  async init() {
    this.entries = {};

    for await (const f of Deno.readDir(this.srcDir)) {
      if (!f.name.match(/^\d+$/)) {
        continue;
      }
      const specDir = [this.srcDir, f.name].join("/");

      const entry = this.entries[f.name] = {};
      // load index
      entry.index = await this._yamlLoad([specDir, "index.yaml"].join("/"));

      // load sub-specs
      entry.specs = {};
      for (const sp of entry.index.specDef) {
        entry.specs[sp.type] = await this._yamlLoad(
          [specDir, `${sp.type}.yaml`].join("/"),
        );

        // post processing of sub-specs
        switch (sp.type) {
          case "speakers":
          case "projects":
          case "partners":
            for (const s of entry.specs[sp.type]) {
              if (!s.photos) {
                s.photos = [];
              }
              for (const [it, format] of this.imageTypes) {
                if (
                  await exists(
                    [
                      this.srcDir,
                      f.name,
                      "photos",
                      sp.type,
                      `${s.id}-${it}.${format}`,
                    ].join("/"),
                  )
                ) {
                  s.photos.push(`${it}:${format}`);
                }
              }
            }
            if (sp.type === "speakers") {
              entry.specs[sp.type] = entry.specs[sp.type].sort((x, y) =>
                x.name.localeCompare(y.name)
              );
            }
            break;
        }
      }
    }
    if (!this.options.silent) {
      console.log(
        `UTXO entries: [ ${Object.keys(this.entries).join(", ")} ]\n`,
      );
    }
  }

  entriesList() {
    return Object.keys(this.entries);
  }

  async build(outputDir = "./dist") {
    await emptyDir(outputDir);
    const entriesIndex = [];

    for (const entryId of Object.keys(this.entries)) {
      if (!this.options.silent) {
        console.log(`UTXO.${entryId}: building specs ..`);
      }
      const entry = this.entries[entryId];
      const entryDir = [outputDir, entryId].join("/");
      await emptyDir(entryDir);

      // write sub-specs
      const specEndpoints = {};
      for (const specName of Object.keys(entry.specs)) {
        await this._jsonWrite(
          [entryDir, `${specName}.json`],
          entry.specs[specName],
        );
        specEndpoints[specName] = `${baseUrl}/${entryId}/${specName}.json`;
      }

      // write index
      const index = JSON.parse(JSON.stringify(entry.index));
      const specDef = JSON.parse(JSON.stringify(index.specDef));

      delete index.specDef;
      index.spec = specEndpoints;
      index.stats = { counts: {} };
      for (const sc of Object.keys(entry.specs)) {
        index.stats.counts[sc] = entry.specs[sc].length;
      }
      index.time = new Date();

      await this._jsonWrite([entryDir, "index.json"], index);

      // write bundle
      const bundle = JSON.parse(JSON.stringify(index));
      bundle.spec = entry.specs;
      await this._jsonWrite([entryDir, "bundle.json"], bundle);

      // copy photos
      const outputPhotosDir = [entryDir, "photos"].join("/");
      if (!this.options.silent) {
        console.log(`UTXO.${entryId}: copying photos ..`);
        console.log(`copying photos to ${outputPhotosDir}`);
      }
      await copy([this.srcDir, entryId, "photos"].join("/"), outputPhotosDir, {
        overwrite: true,
      });

      // copy media-kit
      if (await exists([entryDir, "media-kit"].join("/"))) {
        const outputMediaDir = [entryDir, "media-kit"].join("/");
        if (!this.options.silent) {
          console.log(`UTXO.${entryId}: copying media-kit ..`);
          console.log(`copying media-kit to ${outputMediaDir}`);
        }
        await copy(
          [this.srcDir, entryId, "media-kit"].join("/"),
          outputMediaDir,
          {
            overwrite: true,
          },
        );
      }

      // write QA output of events (schedules)
      if (specDef.find((item) => item.type === "schedule")) {
        const qa = this.qaSummary(entryId);
        await this._jsonWrite([entryDir, "qa-summary.json"], qa);
      }

      // done

      entriesIndex.push({
        id: `utxo${entryId}`,
        entryId,
        url: `${baseUrl}/${entryId}/`,
        schema: `${baseUrl}/schema/${entry.schemaVersion || "1"}/`,
      });
    }

    // write schemas
    const schemaVersion = this.defaultSchemaVersion;
    const schemas = await this.schemas(schemaVersion);

    const outputSchemaDir = [outputDir, "schema", schemaVersion].join("/");
    await emptyDir(outputSchemaDir);
    console.log(`UTXO: writing schema (v${schemaVersion}) ..`);

    const schemaBundle = {};
    for (const schema of schemas) {
      await this._jsonWrite(
        [outputSchemaDir, schema.name + ".json"],
        schema.schema,
      );
      schemaBundle[schema.name] = schema.schema;
    }
    await this._jsonWrite([outputSchemaDir, "bundle.json"], {
      definitions: schemaBundle,
    });

    // write global index
    await this._jsonWrite([outputDir, "index.json"], entriesIndex);

    if (!this.options.silent) {
      console.log("\nBuild done");
    }
  }

  qaSummary(entry) {
    const arr = [];
    for (
      const ev of this.entries[entry].specs.events.filter((ev) =>
        ev.type !== "lightning"
      )
    ) {
      const s = this.entries[entry].specs.schedule.find((s) =>
        s.event === ev.id
      );
      if (!s) {
        throw new Error(`Schedule not found (?): ${ev.id}`);
      }
      arr.push({
        id: s.id,
        eventId: ev.id,
        name: ev.name,
        period: s.period,
      });
    }
    return arr;
  }

  schemaUrl(version = "1", type = "index") {
    return `${baseUrl}/schema/${version}/${type}.json`;
  }

  async schemas(version = "1") {
    const schemaDir = `./utils/schema/${version}`;
    const arr = [];
    for await (const f of Deno.readDir(schemaDir)) {
      const m = f.name.match(/^(.+)\.yaml$/);
      if (!m) {
        continue;
      }
      arr.push({
        name: m[1],
        schema: Object.assign(
          { $id: this.schemaUrl(version, m[1]) },
          await this._yamlLoad([schemaDir, f.name].join("/")),
        ),
      });
    }
    return arr.sort((x, y) => x.name > y.name ? 1 : -1);
  }

  async _yamlLoad(fn) {
    return load(await Deno.readTextFile(fn));
  }

  async _jsonWrite(fn, data) {
    if (Array.isArray(fn)) {
      fn = fn.join("/");
    }
    await Deno.writeTextFile(fn, JSON.stringify(data, null, 2));
    if (!this.options.silent) {
      console.log(`${fn} writed`);
    }
    return true;
  }
}
