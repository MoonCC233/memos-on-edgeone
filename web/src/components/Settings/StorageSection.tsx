import { ServerIcon } from "lucide-react";
import { useTranslate } from "@/utils/i18n";
import SettingGroup from "./SettingGroup";
import { SettingPanel } from "./SettingList";
import SettingSection from "./SettingSection";

const StorageSection = () => {
  const t = useTranslate();

  return (
    <SettingSection title={t("setting.storage.label")}>
      <SettingGroup title={t("setting.storage.current-storage")} description={t("setting.storage.current-storage-description")}>
        <SettingPanel className="rounded-md border border-border bg-muted/20 px-3 py-3">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <ServerIcon className="size-4" />
              <span>{t("setting.storage.current-backend-r2")}</span>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("setting.storage.current-backend-description")}
            </p>
          </div>
        </SettingPanel>
      </SettingGroup>
    </SettingSection>
  );
};

export default StorageSection;
