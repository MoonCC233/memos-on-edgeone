import { isEqual } from "lodash-es";
import { useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useInstance } from "@/contexts/InstanceContext";
import { instanceServiceClient } from "@/connect";
import { InstanceSetting_Key } from "@/types/proto/api/v1/instance_service_pb";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import { SettingPanel } from "./SettingList";
import SettingRow from "./SettingRow";
import SettingSection from "./SettingSection";

interface CloudflareAIConfig {
  enabled: boolean;
  transcriptionModel: string;
  transcriptionLanguage: string;
}

const DEFAULT_TRANSCRIPTION_MODEL = "@cf/openai/whisper";

function deriveConfig(aiSetting: any): CloudflareAIConfig {
  const hasProvider = (aiSetting?.providers || []).length > 0;
  const transcription = aiSetting?.transcription;
  return {
    enabled: hasProvider,
    transcriptionModel: transcription?.model || DEFAULT_TRANSCRIPTION_MODEL,
    transcriptionLanguage: transcription?.language || "",
  };
}

const AISection = () => {
  const t = useTranslate();
  const { aiSetting: originalSetting } = useInstance();
  const savedConfig = useRef<CloudflareAIConfig>(deriveConfig(originalSetting));
  const [config, setConfig] = useState<CloudflareAIConfig>(() => deriveConfig(originalSetting));

  const currentOriginal = deriveConfig(originalSetting);
  if (!isEqual(currentOriginal, savedConfig.current)) {
    savedConfig.current = currentOriginal;
    setConfig(currentOriginal);
  }

  const hasChanges = !isEqual(config, savedConfig.current);

  const handleSave = async () => {
    const providers = config.enabled
      ? [{ id: "cloudflare-ai", title: "Cloudflare Workers AI", type: 1, endpoint: "", apiKey: "", apiKeySet: true, apiKeyHint: "built-in" }]
      : [];
    const transcription = config.enabled
      ? { providerId: "cloudflare-ai", model: config.transcriptionModel, language: config.transcriptionLanguage, prompt: "" }
      : undefined;

    try {
      await instanceServiceClient.updateInstanceSetting({
        setting: {
          name: `instance/settings/${InstanceSetting_Key[InstanceSetting_Key.AI]}`,
          value: { case: "aiSetting", value: { providers, transcription } },
        },
      });
      toast.success(t("message.update-succeed"));
      savedConfig.current = config;
    } catch (error) {
      toast.error("Failed to save AI settings");
    }
  };

  return (
    <SettingSection title={t("setting.ai.label")}>
      <SettingPanel className="bg-muted/30 px-4 py-3">
        <div className="flex max-w-3xl flex-col gap-2">
          <h4 className="text-sm font-semibold text-foreground">Cloudflare Workers AI</h4>
          <p className="text-sm text-muted-foreground">{t("setting.ai.cloudflare-ai-description")}</p>
        </div>
      </SettingPanel>

      <SettingGroup title={t("setting.ai.transcription-title")} description={t("setting.ai.transcription-description")}>
        <SettingRow label={t("setting.ai.transcription-enable")} tooltip={t("setting.ai.transcription-enable-tooltip")}>
          <Switch checked={config.enabled} onCheckedChange={(checked) => setConfig((prev) => ({ ...prev, enabled: checked }))} />
        </SettingRow>

        {config.enabled && (
          <>
            <SettingRow label={t("setting.ai.transcription-model")} description={t("setting.ai.transcription-model-help")}>
              <Input
                className="w-64 font-mono"
                value={config.transcriptionModel}
                onChange={(e) => setConfig((prev) => ({ ...prev, transcriptionModel: e.target.value }))}
                placeholder={DEFAULT_TRANSCRIPTION_MODEL}
              />
            </SettingRow>

            <SettingRow label={t("setting.ai.transcription-language")} description={t("setting.ai.transcription-language-help")}>
              <Input
                className="w-32"
                value={config.transcriptionLanguage}
                onChange={(e) => setConfig((prev) => ({ ...prev, transcriptionLanguage: e.target.value }))}
                placeholder="en"
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
