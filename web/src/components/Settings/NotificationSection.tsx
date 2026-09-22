import { isEqual } from "lodash-es";
import { useEffect, useMemo, useState } from "react";
import { toast } from "react-hot-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { instanceServiceClient } from "@/connect";
import { useInstance } from "@/contexts/InstanceContext";
import useCurrentUser from "@/hooks/useCurrentUser";
import { handleError } from "@/lib/error";
import { InstanceSetting_Key } from "@/types/proto/api/v1/instance_service_pb";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import SettingRow from "./SettingRow";
import SettingSection from "./SettingSection";
import useInstanceSettingUpdater, { buildInstanceSettingName } from "./useInstanceSettingUpdater";

interface ResendEmailSetting {
  enabled: boolean;
  apiKey: string;
  fromEmail: string;
  fromName: string;
  replyTo: string;
}

const NotificationSection = () => {
  const t = useTranslate();
  const saveInstanceSetting = useInstanceSettingUpdater();
  const currentUser = useCurrentUser();
  const { notificationSetting: rawSetting } = useInstance();

  const originalSetting = useMemo((): ResendEmailSetting => {
    const email = (rawSetting as any)?.email || {};
    return {
      enabled: email.enabled ?? false,
      apiKey: email.apiKey ?? "",
      fromEmail: email.fromEmail ?? "",
      fromName: email.fromName ?? "",
      replyTo: email.replyTo ?? "",
    };
  }, [rawSetting]);

  const [setting, setSetting] = useState<ResendEmailSetting>(originalSetting);
  const [isTestingEmail, setIsTestingEmail] = useState(false);

  useEffect(() => {
    setSetting(originalSetting);
  }, [originalSetting]);

  const hasExistingKey = Boolean(originalSetting.apiKey);

  const allowSave = useMemo(() => {
    if (isEqual(originalSetting, setting)) return false;
    if (!setting.enabled) return true;
    return Boolean(setting.apiKey.trim() && setting.fromEmail.trim());
  }, [setting, originalSetting]);

  const canTestEmail = useMemo(() => {
    return Boolean(currentUser?.email && setting.apiKey.trim() && setting.fromEmail.trim());
  }, [currentUser?.email, setting.apiKey, setting.fromEmail]);

  const saveNotificationSetting = async () => {
    const emailValue: any = { ...setting };
    if (!emailValue.apiKey && hasExistingKey) {
      emailValue.apiKey = originalSetting.apiKey;
    }
    await saveInstanceSetting({
      key: InstanceSetting_Key.NOTIFICATION,
      setting: {
        name: buildInstanceSettingName(InstanceSetting_Key.NOTIFICATION),
        value: { case: "notificationSetting", value: { email: emailValue } },
      } as any,
      errorContext: "Update notification settings",
    });
  };

  const testEmailSetting = async () => {
    if (!currentUser?.email) {
      toast.error(t("setting.notification.test-email-missing-recipient"));
      return;
    }
    setIsTestingEmail(true);
    try {
      const emailConfig: any = { ...setting };
      if (!emailConfig.apiKey && hasExistingKey) {
        emailConfig.apiKey = originalSetting.apiKey;
      }
      await instanceServiceClient.testInstanceEmailSetting({
        email: emailConfig,
        recipientEmail: currentUser.email,
      });
      toast.success(t("setting.notification.test-email-success", { email: currentUser.email }));
    } catch (error: unknown) {
      await handleError(error, toast.error, { context: "Send test email" });
    } finally {
      setIsTestingEmail(false);
    }
  };
  return (
    <SettingSection title={t("setting.notification.label")}>
      <SettingGroup title={t("setting.notification.email-title")} description={t("setting.notification.email-description")}>
        <SettingRow label={t("setting.notification.email-enabled")} description={t("setting.notification.email-enabled-description")}>
          <Switch checked={setting.enabled} onCheckedChange={(enabled) => setSetting({ ...setting, enabled })} />
        </SettingRow>

        <SettingRow label={t("setting.notification.api-key")} description={t("setting.notification.api-key-description")}>
          <Input
            className="w-full sm:w-80"
            type="password"
            value={setting.apiKey}
            placeholder={hasExistingKey ? t("setting.notification.api-key-placeholder-existing") : "re_xxxxxxxxxx"}
            autoComplete="new-password"
            onChange={(e) => setSetting({ ...setting, apiKey: e.target.value })}
          />
        </SettingRow>

        <SettingRow label={t("setting.notification.from-email")} description={t("setting.notification.from-email-description")}>
          <Input
            className="w-full sm:w-80"
            type="email"
            value={setting.fromEmail}
            placeholder="noreply@yourdomain.com"
            onChange={(e) => setSetting({ ...setting, fromEmail: e.target.value })}
          />
        </SettingRow>

        <SettingRow label={t("setting.notification.from-name")} description={t("setting.notification.from-name-description")}>
          <Input
            className="w-full sm:w-80"
            value={setting.fromName}
            placeholder="Memos"
            onChange={(e) => setSetting({ ...setting, fromName: e.target.value })}
          />
        </SettingRow>

        <SettingRow label={t("setting.notification.reply-to")} description={t("setting.notification.reply-to-description")}>
          <Input
            className="w-full sm:w-80"
            type="email"
            value={setting.replyTo}
            placeholder="support@example.com"
            onChange={(e) => setSetting({ ...setting, replyTo: e.target.value })}
          />
        </SettingRow>
      </SettingGroup>

      <div className="w-full flex flex-col justify-end gap-2 sm:flex-row">
        <Button variant="outline" disabled={!canTestEmail || isTestingEmail} onClick={testEmailSetting}>
          {isTestingEmail ? t("setting.notification.test-email-sending") : t("setting.notification.test-email")}
        </Button>
        <Button disabled={!allowSave} onClick={saveNotificationSetting}>
          {t("common.save")}
        </Button>
      </div>
    </SettingSection>
  );
};

export default NotificationSection;
