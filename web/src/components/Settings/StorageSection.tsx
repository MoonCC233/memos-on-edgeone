import { isEqual } from "lodash-es";
import { DatabaseIcon, ServerIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "react-hot-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { useInstance } from "@/contexts/InstanceContext";
import { cn } from "@/lib/utils";
import {
  InstanceSetting_Key,
  type InstanceSetting,
  InstanceSetting_StorageSetting_StorageType,
} from "@/types/proto/api/v1/instance_service_pb";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import SettingRow from "./SettingRow";
import SettingSection from "./SettingSection";
import useInstanceSettingUpdater from "./useInstanceSettingUpdater";

interface StorageForm {
  storageType: InstanceSetting_StorageSetting_StorageType;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  // Only holds what the admin typed. The stored secret is never returned by
  // the API; an empty value means "keep the existing secret".
  accessKeySecret: string;
  usePathStyle: boolean;
  uploadSizeLimitMb: string;
  secretSaved: boolean;
}

const BLOB = InstanceSetting_StorageSetting_StorageType.STORAGE_TYPE_UNSPECIFIED;
const S3 = InstanceSetting_StorageSetting_StorageType.S3;

const deriveForm = (setting: any): StorageForm => {
  const cfg = setting?.s3Config;
  const rawLimit = Number(setting?.uploadSizeLimitMb);
  return {
    storageType: Number(setting?.storageType) === S3 ? S3 : BLOB,
    endpoint: cfg?.endpoint || "",
    region: cfg?.region || "",
    bucket: cfg?.bucket || "",
    accessKeyId: cfg?.accessKeyId || "",
    accessKeySecret: "",
    usePathStyle: cfg?.usePathStyle ?? true,
    uploadSizeLimitMb: String(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 100),
    secretSaved: Boolean(cfg?.accessKeySecretSet || cfg?.accessKeySecret),
  };
};

const StorageSection = () => {
  const t = useTranslate();
  const { storageSetting } = useInstance();
  const saveSetting = useInstanceSettingUpdater();

  const derived = deriveForm(storageSetting);
  const [form, setForm] = useState<StorageForm>(derived);
  const savedDerived = useRef<StorageForm>(derived);

  useEffect(() => {
    if (!isEqual(derived, savedDerived.current)) {
      savedDerived.current = derived;
      setForm(derived);
    }
  }, [derived]);

  const hasChanges = !isEqual(form, derived);
  const isS3 = form.storageType === S3;
  const update = (patch: Partial<StorageForm>) => setForm((prev) => ({ ...prev, ...patch }));

  const handleSave = async () => {
    const parsedLimit = Math.floor(Number(form.uploadSizeLimitMb));
    const uploadSizeLimitMb = Number.isFinite(parsedLimit) && parsedLimit >= 1 ? parsedLimit : 100;

    if (isS3) {
      const incomplete =
        !form.endpoint.trim() ||
        !form.bucket.trim() ||
        !form.accessKeyId.trim() ||
        (!form.secretSaved && !form.accessKeySecret.trim());
      if (incomplete) {
        toast.error(t("setting.storage.s3-configuration-incomplete"));
        return;
      }
    }

    // Preserve the existing S3 config when it exists so attachments already
    // stored in S3 stay resolvable after switching the new-attachment backend
    // back to blob.
    const existingS3 = (storageSetting as any)?.s3Config;
    const includeS3 =
      isS3 || Boolean(existingS3) || Boolean(form.endpoint || form.bucket || form.accessKeyId);

    const value: Record<string, unknown> = {
      storageType: form.storageType,
      filepathTemplate: typeof (storageSetting as any)?.filepathTemplate === "string" ? (storageSetting as any).filepathTemplate : "",
      uploadSizeLimitMb,
    };
    if (includeS3) {
      const baseS3: any = existingS3 ? { ...existingS3 } : {};
      delete baseS3.accessKeySecret;
      delete baseS3.accessKeySecretSet;
      value.s3Config = {
        ...baseS3,
        endpoint: form.endpoint.trim(),
        region: form.region.trim(),
        bucket: form.bucket.trim(),
        accessKeyId: form.accessKeyId.trim(),
        usePathStyle: form.usePathStyle,
        ...(form.accessKeySecret ? { accessKeySecret: form.accessKeySecret } : {}),
      };
    }

    await saveSetting({
      key: InstanceSetting_Key.STORAGE,
      setting: {
        name: `instance/settings/${InstanceSetting_Key[InstanceSetting_Key.STORAGE]}`,
        value: { case: "storageSetting", value },
      } as unknown as InstanceSetting,
      errorContext: t("setting.storage.label"),
    });
  };

  const renderBackendOption = (
    value: InstanceSetting_StorageSetting_StorageType,
    id: string,
    icon: ReactNode,
    title: string,
    description: string,
    badge?: string,
  ) => {
    const selected = form.storageType === value;
    return (
      <div
        className={cn(
          "flex cursor-pointer flex-col gap-2 rounded-md border p-3 transition-colors",
          selected ? "border-primary bg-muted/40" : "border-border bg-muted/20 hover:bg-muted/40",
        )}
        onClick={() => update({ storageType: value })}
      >
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <RadioGroupItem value={String(value)} id={id} aria-label={title} />
          <label htmlFor={id} className="flex cursor-pointer items-center gap-2">
            {icon}
            <span>{title}</span>
            {badge && <Badge variant="secondary">{badge}</Badge>}
          </label>
        </div>
        <p className="pl-6 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
    );
  };

  return (
    <SettingSection title={t("setting.storage.label")}>
      <SettingGroup title={t("setting.storage.current-storage")} description={t("setting.storage.current-storage-description")}>
        <RadioGroup
          value={String(form.storageType)}
          onValueChange={(value) => update({ storageType: Number(value) as InstanceSetting_StorageSetting_StorageType })}
          className="grid gap-3 sm:grid-cols-2"
        >
          {renderBackendOption(
            BLOB,
            "storage-type-blob",
            <DatabaseIcon className="size-4" />,
            t("setting.storage.type-blob"),
            t("setting.storage.blob-description"),
            t("setting.storage.badge-default"),
          )}
          {renderBackendOption(
            S3,
            "storage-type-s3",
            <ServerIcon className="size-4" />,
            t("setting.storage.type-s3"),
            t("setting.storage.s3-description"),
          )}
        </RadioGroup>
      </SettingGroup>

      {isS3 && (
        <SettingGroup title={t("setting.storage.s3-configuration")} description={t("setting.storage.s3-configuration-description")}>
          <SettingRow label={t("setting.storage.endpoint")} description={t("setting.storage.endpoint-description")}>
            <Input
              className="w-64"
              value={form.endpoint}
              onChange={(e) => update({ endpoint: e.target.value })}
              placeholder="https://s3.example.com"
              autoComplete="off"
            />
          </SettingRow>
          <SettingRow label={t("setting.storage.region")} description={t("setting.storage.region-description")}>
            <Input
              className="w-48"
              value={form.region}
              onChange={(e) => update({ region: e.target.value })}
              placeholder={t("setting.storage.region-placeholder")}
              autoComplete="off"
            />
          </SettingRow>
          <SettingRow label={t("setting.storage.bucket")} description={t("setting.storage.bucket-description")}>
            <Input
              className="w-64"
              value={form.bucket}
              onChange={(e) => update({ bucket: e.target.value })}
              placeholder={t("setting.storage.bucket-placeholder")}
              autoComplete="off"
            />
          </SettingRow>
          <SettingRow label={t("setting.storage.accesskey")} description={t("setting.storage.accesskey-description")}>
            <Input
              className="w-64"
              value={form.accessKeyId}
              onChange={(e) => update({ accessKeyId: e.target.value })}
              placeholder={t("setting.storage.accesskey-placeholder")}
              autoComplete="off"
            />
          </SettingRow>
          <SettingRow
            label={t("setting.storage.secretkey")}
            description={
              form.secretSaved
                ? t("setting.storage.secretkey-preserve-description")
                : t("setting.storage.secretkey-description")
            }
          >
            <Input
              className="w-64"
              type="password"
              autoComplete="new-password"
              value={form.accessKeySecret}
              onChange={(e) => update({ accessKeySecret: e.target.value })}
              placeholder={form.secretSaved ? "••••••••" : t("setting.storage.secretkey-placeholder")}
            />
          </SettingRow>
          <SettingRow label={t("setting.storage.use-path-style")} description={t("setting.storage.use-path-style-description")}>
            <Switch checked={form.usePathStyle} onCheckedChange={(checked) => update({ usePathStyle: checked })} />
          </SettingRow>
          <p className="text-xs leading-5 text-muted-foreground">{t("setting.storage.s3-note-config")}</p>
        </SettingGroup>
      )}

      <SettingGroup title={t("setting.storage.upload-limit")} description={t("setting.storage.upload-limit-description")}>
        <SettingRow label={t("setting.storage.upload-limit")}>
          <Input
            className="w-32"
            type="number"
            min={1}
            inputMode="numeric"
            value={form.uploadSizeLimitMb}
            onChange={(e) => update({ uploadSizeLimitMb: e.target.value.replace(/[^0-9]/g, "") })}
          />
        </SettingRow>
      </SettingGroup>

      <div className="flex w-full justify-end">
        <Button disabled={!hasChanges} onClick={handleSave}>
          {t("common.save")}
        </Button>
      </div>
    </SettingSection>
  );
};

export default StorageSection;
