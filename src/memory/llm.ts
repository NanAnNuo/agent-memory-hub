import type { HubSettings } from "../archive/types.js";

export interface ImportedModel {
  id: string;
  ownedBy?: string;
}

export function publicSettings(settings: HubSettings): Omit<HubSettings, "llmApiKey" | "embeddingApiKey"> & { llmApiKey: string; embeddingApiKey: string } {
  return {
    ...settings,
    llmApiKey: maskSecret(settings.llmApiKey),
    embeddingApiKey: maskSecret(settings.embeddingApiKey)
  };
}

export async function importModels(baseUrl: string, apiKey: string): Promise<ImportedModel[]> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) {
    throw new Error(`Model import failed with HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as { data?: Array<{ id?: string; owned_by?: string }> };
  return (data.data ?? []).map((model) => ({ id: String(model.id ?? ""), ownedBy: model.owned_by })).filter((model) => model.id);
}

export async function testLlm(settings: HubSettings): Promise<{ ok: boolean; error: string | null }> {
  try {
    if (!settings.llmBaseUrl || !settings.llmModel || !settings.llmApiKey) {
      throw new Error("base_url, model, and api_key are required.");
    }
    const response = await fetch(`${settings.llmBaseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.llmApiKey}`
      },
      body: JSON.stringify({
        model: settings.llmModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function maskSecret(value: string): string {
  if (!value) {
    return "";
  }
  return value.length <= 8 ? "********" : `${value.slice(0, 4)}...${value.slice(-4)}`;
}
