
import React, { useState } from "react";
import { createClient, Entry } from "contentful-management";

type LogFn = (msg: string) => void;

interface CFEnv {
  spaceId: string;
  envId: string;
  token: string;
}

const LOCALE_MAP: Record<string, string | string[]> = {
  "en-US": "en-CA"
};

function remapLocales(fields: any, log?: LogFn) {
  const out: any = {};

  for (const fieldId of Object.keys(fields)) {
    const localized = fields[fieldId];
    const newLocalized: any = {};

    for (const srcLocale of Object.keys(localized)) {
      const value = localized[srcLocale];
      const mapping = LOCALE_MAP[srcLocale];
      if (!mapping) continue;

      const targets = Array.isArray(mapping) ? mapping : [mapping];
      for (const t of targets) {
        newLocalized[t] = value;
      }
    }

    if (Object.keys(newLocalized).length > 0) {
      out[fieldId] = newLocalized;
      if (log) {
        log(
          `  Field '${fieldId}': locales ${Object.keys(localized).join(
            ", "
          )} -> ${Object.keys(newLocalized).join(", ")}`
        );
      }
    }
  }

  return out;
}

export default function App() {
  const [source, setSource] = useState<CFEnv>({
    spaceId: "",
    envId: "",
    token: ""
  });
  const [target, setTarget] = useState<CFEnv>({
    spaceId: "",
    envId: "",
    token: ""
  });

  const [entryId, setEntryId] = useState("");
  const [log, setLog] = useState("");

  const append: LogFn = (msg) => setLog((prev) => prev + msg + "\n");

  const getEnv = async (cfg: CFEnv) => {
    const client = createClient({ accessToken: cfg.token });
    const space = await client.getSpace(cfg.spaceId);
    return await space.getEnvironment(cfg.envId);
  };

  async function collectHierarchy(
    env: any,
    rootId: string,
    collected = new Map<string, Entry>()
  ): Promise<Map<string, Entry>> {
    if (collected.has(rootId)) return collected;

    const entry = await env.getEntry(rootId);
    collected.set(rootId, entry);
    append(`Collected entry: ${rootId}`);

    const walkValue = async (val: any): Promise<void> => {
      if (!val) return;

      if (Array.isArray(val)) {
        for (const item of val) {
          await walkValue(item);
        }
        return;
      }

      if (typeof val === "object") {
        if (val.sys?.type === "Link" && val.sys.linkType === "Entry") {
          const childId = val.sys.id;
          if (!collected.has(childId)) {
            append(`  Found child entry link: ${childId}`);
            await collectHierarchy(env, childId, collected);
          }
          return;
        }

        for (const key of Object.keys(val)) {
          await walkValue(val[key]);
        }
      }
    };

    for (const fieldId of Object.keys(entry.fields)) {
      const localized = (entry.fields as any)[fieldId];
      for (const locale of Object.keys(localized)) {
        await walkValue(localized[locale]);
      }
    }

    return collected;
  }

  async function copyEntries(
    _sourceEnv: any,
    targetEnv: any,
    entries: Map<string, Entry>
  ) {
    const idMap = new Map<string, string>();
    const ordered = Array.from(entries.values()).reverse();

    for (const entry of ordered) {
      const oldId = entry.sys.id;
      append(`Creating target entry for ${oldId} (type: ${entry.sys.contentType?.sys.id})`);

      const clonedFieldsRaw = JSON.parse(JSON.stringify(entry.fields));
      const clonedFields = remapLocales(clonedFieldsRaw, append);

      const locales = Object.keys(clonedFields);
      append(`  Target fields for ${oldId}: ${
        locales.length ? locales.join(", ") : "NO MAPPED LOCALES"
      }`);

      const newEntry = await targetEnv.createEntry(
        entry.sys.contentType.sys.id,
        { fields: clonedFields }
      );

      append(`  Created ${oldId} -> ${newEntry.sys.id}`);
      idMap.set(oldId, newEntry.sys.id);
    }

    return idMap;
  }

  function rewriteReferences(entry: Entry, idMap: Map<string, string>): any {
    const cloned = JSON.parse(JSON.stringify(entry.fields));

    const updateLinks = (val: any): any => {
      if (!val) return val;

      if (Array.isArray(val)) return val.map(updateLinks);

      if (typeof val === "object") {
        if (val.sys?.type === "Link" && val.sys.linkType === "Entry") {
          const oldId = val.sys.id;
          const newId = idMap.get(oldId) || oldId;
          return { sys: { ...val.sys, id: newId } };
        }

        const out: any = {};
        for (const key of Object.keys(val)) {
          out[key] = updateLinks(val[key]);
        }
        return out;
      }

      return val;
    };

    for (const fieldId of Object.keys(cloned)) {
      const localized = cloned[fieldId];
      for (const locale of Object.keys(localized)) {
        localized[locale] = updateLinks(localized[locale]);
      }
    }

    const remapped = remapLocales(cloned);
    return remapped;
  }

  async function applyReferenceFixes(
    targetEnv: any,
    entries: Map<string, Entry>,
    idMap: Map<string, string>,
    log: LogFn
  ) {
    const updated: { updatedEntry: any; sourceEntry: Entry }[] = [];

    log("Updating entries in target with rewritten references (no publish yet)...");

    for (const entry of entries.values()) {
      const oldId = entry.sys.id;
      const newId = idMap.get(oldId)!;

      const targetEntry = await targetEnv.getEntry(newId);
      targetEntry.fields = rewriteReferences(entry, idMap);

      const u = await targetEntry.update();
      updated.push({ updatedEntry: u, sourceEntry: entry });

      log(`  Updated refs for target ${newId} (from ${oldId})`);
    }

    log("Publishing entries (where source was published)...");

    for (const { updatedEntry, sourceEntry } of updated) {
      if ((sourceEntry as any).isPublished && (sourceEntry as any).isPublished()) {
        await updatedEntry.publish();
        log(`  Published ${updatedEntry.sys.id}`);
      } else {
        log(`  Skipped publish for ${updatedEntry.sys.id} (source not published)`);
      }
    }
  }

  const run = async () => {
    try {
      setLog("");
      append("Starting migration run...");

      if (!source.spaceId || !source.envId || !source.token) {
        append("❌ Missing source config");
        return;
      }
      if (!target.spaceId || !target.envId || !target.token) {
        append("❌ Missing target config");
        return;
      }
      if (!entryId) {
        append("❌ Missing root entry ID");
        return;
      }

      const sourceEnv = await getEnv(source);
      const targetEnv = await getEnv(target);

      append(`Collecting entry tree starting from root ID: ${entryId}`);
      const entries = await collectHierarchy(sourceEnv, entryId);
      append(`Total entries discovered (root + children): ${entries.size}`);

      append("Creating entries in target (unpublished) with locale remapping...");
      const idMap = await copyEntries(sourceEnv, targetEnv, entries);

      append("Rewriting references + updating target entries...");
      await applyReferenceFixes(targetEnv, entries, idMap, append);

      append("✅ Migration complete.");
    } catch (e: any) {
      append("❌ ERROR: " + (e?.message || JSON.stringify(e)));
    }
  };

  return (
    <div style={{ padding: 20, maxWidth: 900, margin: "0 auto", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <h2>Contentful Entry + Children Mover (Final, Locale-Aware)</h2>

      <p style={{ fontSize: 13, color: "#555" }}>
        Copies a root entry and all linked child entries from one space/environment to another,
        remapping locales (e.g., en-US → en-CA) and fixing references.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
        <div>
          <h3>Source</h3>
          <input
            placeholder="Source Space ID"
            style={{ width: "100%", marginBottom: 6 }}
            value={source.spaceId}
            onChange={(e) => setSource({ ...source, spaceId: e.target.value })}
          />
          <input
            placeholder="Source Environment ID"
            style={{ width: "100%", marginBottom: 6 }}
            value={source.envId}
            onChange={(e) => setSource({ ...source, envId: e.target.value })}
          />
          <input
            placeholder="Source Management Token"
            type="password"
            style={{ width: "100%", marginBottom: 6 }}
            value={source.token}
            onChange={(e) => setSource({ ...source, token: e.target.value })}
          />
        </div>

        <div>
          <h3>Target</h3>
          <input
            placeholder="Target Space ID"
            style={{ width: "100%", marginBottom: 6 }}
            value={target.spaceId}
            onChange={(e) => setTarget({ ...target, spaceId: e.target.value })}
          />
          <input
            placeholder="Target Environment ID"
            style={{ width: "100%", marginBottom: 6 }}
            value={target.envId}
            onChange={(e) => setTarget({ ...target, envId: e.target.value })}
          />
          <input
            placeholder="Target Management Token"
            type="password"
            style={{ width: "100%", marginBottom: 6 }}
            value={target.token}
            onChange={(e) => setTarget({ ...target, token: e.target.value })}
          />
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <h3>Root Entry</h3>
        <input
          placeholder="Root Entry ID"
          style={{ width: "100%" }}
          value={entryId}
          onChange={(e) => setEntryId(e.target.value)}
        />
      </div>

      <button
        onClick={run}
        style={{
          marginTop: 16,
          padding: "10px 16px",
          background: "#2563eb",
          color: "white",
          border: "none",
          borderRadius: 4,
          cursor: "pointer"
        }}
      >
        Run Migration
      </button>

      <h3 style={{ marginTop: 20 }}>Log</h3>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          background: "#111",
          color: "#0f0",
          padding: 10,
          height: 320,
          overflow: "auto",
          borderRadius: 4,
          fontSize: 12
        }}
      >
        {log || "Waiting..."}
      </pre>
    </div>
  );
}
