// The plugin's settings panel (Steam menu → Millennium Library Manager → Price
// History): region, "willing to wait" time and the IsThereAnyDeal API key.
// The button and dialog on store pages are in webview/.

import { definePlugin, DialogButton, Dropdown, Field, TextField } from "millennium";
import { useEffect, useState } from "react";
import {
  ESTIMATED_REGIONS,
  ITAD_APPS_URL,
  parseSettings,
  REGIONS,
  Settings,
  WAIT_CHOICES,
} from "../common/constants";
import { check, log } from "../common/health";
import { decodeBackendJson } from "../common/backend-json";

const regionName = (code: string) => REGIONS.find(([c]) => c === code)?.[1] ?? code;

// Opens a web page in the computer's browser (Steam's internal function).
function openInBrowser(url: string) {
  const open = (window as any).SteamClient?.System?.OpenInSystemBrowser;
  if (check("Steam's open-in-browser function (SteamClient.System.OpenInSystemBrowser)", typeof open === "function")) {
    open(url);
  }
}

async function logSteamVersion() {
  try {
    const i = await (window as any).SteamClient.System.GetSystemInfo();
    log("info", `Steam ${i.nSteamVersion} (built ${i.sSteamBuildDate}), ${i.sOSName ?? "unknown OS"}`);
  } catch (e) {
    log("warning", `Couldn't read the Steam version (${e})`);
  }
}

function ProblemsSection() {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    const load = () =>
      backend
        .get_problems()
        .then((text: unknown) => {
          const parsed = decodeBackendJson(text);
          setList(Array.isArray(parsed) ? parsed.map(String) : []);
        })
        .catch(() => {});
    load();
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, []);
  if (!list.length) return null;
  return (
    <>
      {list.map((p) => (
        <Field
          key={p}
          label="Problem found"
          description={`${p}. Steam may have changed. Details are in Millennium's log for this plugin.`}
        />
      ))}
    </>
  );
}

function RegionSetting({ settings, reload }: { settings: Settings; reload: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const detected = settings.detected ? regionName(settings.detected) : null;
  const options = [
    { data: "", label: detected ? `Automatic (${detected})` : "Automatic" },
    ...REGIONS.map(([code, name]) => ({
      data: code,
      label: ESTIMATED_REGIONS.has(code) ? `${name} (estimated history)` : name,
    })),
  ];
  return (
    <Field
      label="Prices for"
      description={
        error ??
        (detected
          ? `Automatic uses your Steam store region (${detected}).`
          : "Automatic uses your Steam store region (detected when you open a Price History dialog).") +
          ' "Estimated history": IsThereAnyDeal doesn\'t track that currency, so past prices are worked out from discounts.'
      }
    >
      <Dropdown
        rgOptions={options}
        selectedOption={settings.region}
        menuLabel="Prices for"
        onChange={async (o) => {
          const problem = await backend.set_region(o.data).catch((e: unknown) => String(e));
          setError(problem ? `Saving failed (${problem})` : null);
          reload();
        }}
      />
    </Field>
  );
}

function WaitSetting({ settings, reload }: { settings: Settings; reload: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Field
      label="Willing to wait"
      description={
        error ??
        'For games at full price: is a sale likely within this time? Longer times make most games say "likely".'
      }
    >
      <Dropdown
        rgOptions={WAIT_CHOICES.map((c) => ({ data: c.days, label: c.label }))}
        selectedOption={settings.wait_days}
        menuLabel="Willing to wait"
        onChange={async (o) => {
          const problem = await backend.set_wait_days(o.data).catch((e: unknown) => String(e));
          setError(problem ? `Saving failed (${problem})` : null);
          reload();
        }}
      />
    </Field>
  );
}

function ApiKeySetting({ reload }: { reload: () => void }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    backend
      .get_api_key()
      .then((k: string) => {
        setSaved(k);
        setDraft(k);
      })
      .catch((e: unknown) => setMessage(`Couldn't read the saved key (${e})`));
  }, []);

  const save = async () => {
    const key = draft.trim();
    setBusy(true);
    setMessage(key ? "Checking the key…" : null);
    try {
      if (key) {
        const problem = await backend.test_api_key(key);
        if (problem) {
          setMessage(`IsThereAnyDeal rejected this key: ${problem}`);
          return;
        }
      }
      const problem = await backend.set_api_key(key);
      if (problem) {
        setMessage(`Saving failed (${problem})`);
        return;
      }
      setSaved(key);
      setMessage(key ? "Key works and is saved." : "Key removed.");
      reload();
    } catch (e) {
      setMessage(`Saving failed (${e})`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Field
        label="IsThereAnyDeal API key"
        description={message ?? (saved ? "Saved" : "Needed for the price history and lowest price")}
      >
        <TextField value={draft} onChange={(e) => setDraft((e.target as HTMLInputElement).value)} />
      </Field>
      <Field>
        <DialogButton disabled={busy || draft.trim() === (saved ?? "")} onClick={save}>
          Save key
        </DialogButton>
        <DialogButton onClick={() => openInBrowser(ITAD_APPS_URL)}>Get a free key</DialogButton>
      </Field>
    </>
  );
}

function SettingsContent() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    backend
      .get_settings()
      .then((text: unknown) => {
        setSettings(parseSettings(text));
        setError(null);
      })
      .catch((e: unknown) => setError(`Couldn't read the settings (${e})`));
  useEffect(() => {
    reload();
  }, []);

  return (
    <>
      <ProblemsSection />
      <Field
        label="How to use"
        description="On a game's Steam store page, click the Price History button (bottom right) to see its Steam price history in your region's currency."
      />
      {error && <Field label="Problem" description={error} />}
      {settings && <RegionSetting settings={settings} reload={reload} />}
      {settings && <WaitSetting settings={settings} reload={reload} />}
      <ApiKeySetting reload={reload} />
    </>
  );
}

const Icon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 17 9 11 13 15 21 7" />
    <polyline points="15 7 21 7 21 13" />
  </svg>
);

export default definePlugin(() => {
  log("info", "settings panel loaded");
  logSteamVersion();
  return {
    title: "Price History",
    icon: <Icon />,
    content: <SettingsContent />,
  };
});
