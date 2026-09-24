import { isEqual } from "lodash-es";
import { useEffect, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useInstance } from "@/contexts/InstanceContext";
import {
  InstanceSetting_AIProviderType,
  InstanceSetting_Key,
  type InstanceSetting,
} from "@/types/proto/api/v1/instance_service_pb";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import { SettingPanel } from "./SettingList";
import SettingRow from "./SettingRow";
import SettingSection from "./SettingSection";
import useInstanceSettingUpdater from "./useInstanceSettingUpdater";

interface AIForm {
  enabled: boolean;
  endpoint: string;
  // Only holds what the admin typed. The stored key is never returned by the
  // API; an empty value means "keep the existing key".
  apiKey: string;
  model: string;
  language: string;
  prompt: string;
  keySaved: boolean;
}

const PROVIDER_ID = "custom-ai";
const DEFAULT_TRANSCRIPTION_MODEL = "whisper-1";

function deriveForm(aiSetting: any): AIForm {
  const transcription = aiSetting?.transcription;
  const providers = Array.isArray(aiSetting?.providers) ? aiSetting.providers : [];
  const provider = providers.find((p: any) => p && p.id === transcription?.providerId) || providers[0];
  const configuredModel = String(transcription?.model || "");
  return {
    enabled: Boolean(transcription?.providerId),
    endpoint: provider?.endpoint || "",
    apiKey: "",
    // Legacy Cloudflare model ids don't exist on OpenAI-compatible APIs.
    model: configuredModel && !configuredModel.startsWith("@cf/") ? configuredModel : DEFAULT_TRANSCRIPTION_MODEL,
    language: transcription?.language || "",
    prompt: transcription?.prompt || "",
    // "built-in" is the legacy Cloudflare placeholder — no real key is stored.
    keySaved: Boolean(provider?.apiKeySet) && provider?.apiKeyHint !== "built-in",
  };
}

const AISection = () => {
  const t = useTranslate();
  const { aiSetting } = useInstance();
  const saveSetting = useInstanceSettingUpdater();

  const derived = deriveForm(aiSetting);
  const [form, setForm] = useState<AIForm>(derived);
  const savedDerived = useRef<AIForm>(derived);

  useEffect(() => {
    if (!isEqual(derived, savedDerived.current)) {
      savedDerived.current = derived;
      setForm(derived);
    }
  }, [derived]);

  const hasChanges = !isEqual(form, derived);
  const update = (patch: Partial<AIForm>) => setForm((prev) => ({ ...prev, ...patch }));

  const handleSave = async () => {
    const endpoint = form.endpoint.trim();
    const typedKey = form.apiKey.trim();

    if (form.enabled && !endpoint) {
      toast.error(t("setting.ai.endpoint-required"));
      return;
    }
    if (form.enabled && !typedKey && !form.keySaved) {
      toast.error(t("setting.ai.api-key-required"));
      return;
    }

    // Keep the provider (endpoint/key) even while transcription is off so the
    // configuration isn't lost; transcription is enabled via providerId.
    const providers =
      endpoint || typedKey
        ? [
            {
              id: PROVIDER_ID,
              title: "Custom AI API",
              type: InstanceSetting_AIProviderType.OPENAI,
              endpoint,
              apiKey: typedKey,
            },
          ]
        : [];
    const transcription =
      form.enabled && providers.length > 0
        ? {
            providerId: PROVIDER_ID,
            model: form.model.trim() || DEFAULT_TRANSCRIPTION_MODEL,
            language: form.language.trim(),
            prompt: form.prompt,
          }
        : undefined;

    await saveSetting({
      key: InstanceSetting_Key.AI,
      setting: {
        name: `instance/settings/${InstanceSetting_Key[InstanceSetting_Key.AI]}`,
        value: { case: "aiSetting", value: { providers, transcription } },
      } as unknown as InstanceSetting,
      errorContext: t("setting.ai.label"),
    });
  };

  return (
    <SettingSection title={t("setting.ai.label")}>
      <SettingPanel className="bg-muted/30 px-4 py-3">
        <div className="flex max-w-3xl flex-col gap-2">
          <h4 className="text-sm font-semibold text-foreground">{t("setting.ai.custom-api-title")}</h4>
          <p className="text-sm text-muted-foreground">{t("setting.ai.custom-api-description")}</p>
        </div>
      </SettingPanel>

      <SettingGroup title={t("setting.ai.transcription-title")} description={t("setting.ai.transcription-description")}>
        <SettingRow label={t("setting.ai.transcription-enable")} tooltip={t("setting.ai.transcription-enable-tooltip")}>
          <Switch checked={form.enabled} onCheckedChange={(checked) => update({ enabled: checked })} />
        </SettingRow>

        <SettingRow label={t("setting.ai.endpoint")} description={t("setting.ai.endpoint-description")}>
          <Input
            className="w-96 max-w-full"
            value={form.endpoint}
            onChange={(e) => update({ endpoint: e.target.value })}
            placeholder="https://api.openai.com/v1"
            autoComplete="off"
            spellCheck={false}
          />
        </SettingRow>

        <SettingRow
          label={t("setting.ai.api-key")}
          description={form.keySaved ? t("setting.ai.keep-api-key") : t("setting.ai.api-key-description")}
        >
          <Input
            className="w-96 max-w-full"
            type="password"
            autoComplete="new-password"
            value={form.apiKey}
            onChange={(e) => update({ apiKey: e.target.value })}
            placeholder={form.keySaved ? "••••••••" : "sk-..."}
          />
        </SettingRow>

        {form.enabled && (
          <>
            <SettingRow label={t("setting.ai.transcription-model")} description={t("setting.ai.transcription-model-help")}>
              <Input
                className="w-64 font-mono"
                value={form.model}
                onChange={(e) => update({ model: e.target.value })}
                placeholder={t("setting.ai.transcription-model-placeholder-openai")}
                autoComplete="off"
                spellCheck={false}
              />
            </SettingRow>

            <SettingRow label={t("setting.ai.transcription-language")} description={t("setting.ai.transcription-language-help")}>
              <Input
                className="w-32"
                value={form.language}
                onChange={(e) => update({ language: e.target.value })}
                placeholder={t("setting.ai.transcription-language-placeholder")}
                autoComplete="off"
              />
            </SettingRow>

            <SettingRow label={t("setting.ai.transcription-prompt")} description={t("setting.ai.transcription-prompt-help")}>
              <Input
                className="w-96 max-w-full"
                value={form.prompt}
                onChange={(e) => update({ prompt: e.target.value })}
                placeholder={t("setting.ai.transcription-prompt-placeholder")}
                autoComplete="off"
              />
            </SettingRow>
          </>
        )}
      </SettingGroup>

      <div className="w-full flex justify-end">
        <Button disabled={!hasChanges} onClick={handleSave}>
          {t("common.save")}
        </Button>
      </div>
    </SettingSection>
  );
};

export default AISection;
