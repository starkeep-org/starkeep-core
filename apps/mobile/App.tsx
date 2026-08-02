import { useEffect, useState } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { DATABASE_PATH, OBJECTS_PATH, createLocalObjectStorage, opSqliteDriver } from "./src/platform";
import { JOB_GRAPH, runnableJobs, type DeviceState } from "./src/work/job-graph";

/**
 * The dev-client shell (item 12b).
 *
 * Deliberately a diagnostics screen rather than a photo grid. The grid is item
 * 15 and depends on this working; putting it here first would mean the first
 * thing anyone sees on a device is a UI failing for reasons that could be the
 * database, the storage, the sync, or the layout — with no way to tell which.
 *
 * So this answers the questions that must be true before a grid means anything:
 * did the database open, did object storage initialise, and what would the
 * scheduler run right now. On a handset those are the three things nobody can
 * check from a laptop.
 */

interface Check {
  readonly name: string;
  readonly detail: string;
  readonly ok: boolean;
}

export default function App() {
  const [checks, setChecks] = useState<Check[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const results: Check[] = [];

      // The database. Opening it is the whole op-sqlite driver path — including
      // the schema bootstrap, which is the first thing that would break if
      // op-sqlite's exec ran only the first statement of a batch.
      try {
        const db = opSqliteDriver.open(DATABASE_PATH);
        db.exec("CREATE TABLE IF NOT EXISTS shell_probe (k TEXT PRIMARY KEY, v INTEGER)");
        db.prepare("INSERT OR REPLACE INTO shell_probe VALUES (?, ?)").run("boot", Date.now());
        const row = db.prepare("SELECT v FROM shell_probe WHERE k = ?").get("boot") as
          | { v: number }
          | undefined;
        opSqliteDriver.close(db);
        results.push({
          name: "SQLite (op-sqlite)",
          detail: row ? `wrote and read back ${new Date(row.v).toISOString()}` : "no row returned",
          ok: Boolean(row),
        });
      } catch (err) {
        results.push({ name: "SQLite (op-sqlite)", detail: String(err), ok: false });
      }

      // Object storage, including a ranged read — the one behaviour that was
      // verified against a fake and matters most on a device, since video
      // seeking depends on `FileHandle.offset` doing what the docs say.
      try {
        const storage = createLocalObjectStorage();
        await storage.init();
        const key = "0".repeat(64);
        const payload = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
        await storage.put(key, payload);
        const stream = await storage.getStream(key, { start: 8, end: 11 });
        const reader = stream!.getReader();
        const { value } = await reader.read();
        await reader.cancel();
        const got = Array.from(value ?? []);
        results.push({
          name: "Object storage (expo-file-system)",
          detail: `ranged read returned [${got.join(", ")}] — expected [8, 9, 10, 11]`,
          ok: got.join(",") === "8,9,10,11",
        });
      } catch (err) {
        results.push({ name: "Object storage (expo-file-system)", detail: String(err), ok: false });
      }

      if (!cancelled) setChecks(results);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Assumed conditions until item 13 supplies the real ones. Stated as such
  // rather than presented as measured — a diagnostics screen that quietly makes
  // things up is worse than one that says it does not know yet.
  const assumedDevice: DeviceState = {
    hasNetwork: true,
    isUnmetered: true,
    isCharging: false,
    isStorageLow: false,
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Starkeep</Text>
        <Text style={styles.subtitle}>Node diagnostics</Text>

        <Section title="Adapters">
          {checks === null ? (
            <Text style={styles.muted}>Checking…</Text>
          ) : (
            checks.map((c) => (
              <View key={c.name} style={styles.row}>
                <Text style={[styles.badge, c.ok ? styles.ok : styles.bad]}>
                  {c.ok ? "PASS" : "FAIL"}
                </Text>
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{c.name}</Text>
                  <Text style={styles.muted}>{c.detail}</Text>
                </View>
              </View>
            ))
          )}
        </Section>

        <Section title="Paths">
          <Text style={styles.mono}>{DATABASE_PATH}</Text>
          <Text style={styles.mono}>{OBJECTS_PATH}</Text>
        </Section>

        <Section title="Scheduler (assumed conditions)">
          <Text style={styles.muted}>
            Device conditions are assumed until item 13 reports them. Runnable now:
          </Text>
          {runnableJobs(assumedDevice).map((id) => (
            <Text key={id} style={styles.mono}>
              {id}
            </Text>
          ))}
          <Text style={styles.muted}>
            {JOB_GRAPH.length} jobs declared; none scheduled yet — WorkManager binding is item 14.
          </Text>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#111" },
  content: { padding: 20, gap: 20 },
  title: { color: "#fff", fontSize: 28, fontWeight: "600" },
  subtitle: { color: "#888", fontSize: 14, marginTop: -14 },
  section: { gap: 8 },
  sectionTitle: {
    color: "#888",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  row: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: "#eee", fontSize: 15 },
  badge: { fontSize: 11, fontWeight: "700", paddingTop: 3 },
  ok: { color: "#4ade80" },
  bad: { color: "#f87171" },
  muted: { color: "#888", fontSize: 13 },
  mono: { color: "#ccc", fontSize: 12, fontFamily: "monospace" },
});
