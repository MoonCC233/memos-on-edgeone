import { useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { buildMemoCreatorFilter } from "@/helpers/resource-names";
import { Visibility } from "@/types/proto/api/v1/memo_service_pb";

const getVisibilityName = (visibility: Visibility): string => {
  switch (visibility) {
    case Visibility.PUBLIC:
      return "PUBLIC";
    case Visibility.PROTECTED:
      return "PROTECTED";
    case Visibility.PRIVATE:
      return "PRIVATE";
    default:
      return "PRIVATE";
  }
};

const getShortcutId = (name: string): string => {
  const parts = name.split("/");
  const index = parts.lastIndexOf("shortcuts");
  return index >= 0 ? parts[index + 1] || "" : "";
};

const escapeFilterValue = (value: string): string => JSON.stringify(value);

export interface UseMemoFiltersOptions {
  creatorName?: string;
  includeShortcuts?: boolean;
  includePinned?: boolean;
  visibilities?: Visibility[];
}

export const useMemoFilters = (options: UseMemoFiltersOptions = {}): string | undefined => {
  const { creatorName, includeShortcuts = false, includePinned = false, visibilities } = options;

  const { shortcuts } = useAuth();
  const { filters, shortcut: currentShortcut } = useMemoFilterContext();

  // Get selected shortcut if needed
  const selectedShortcut = useMemo(() => {
    if (!includeShortcuts) return undefined;
    return shortcuts.find((shortcut) => getShortcutId(shortcut.name) === currentShortcut);
  }, [includeShortcuts, currentShortcut, shortcuts]);

  // Build filter
  return useMemo(() => {
    const conditions: string[] = [];

    // Add creator filter if provided
    if (creatorName) {
      const creatorFilter = buildMemoCreatorFilter(creatorName);
      if (creatorFilter) {
        conditions.push(creatorFilter);
      }
    }

    // Add shortcut filter if enabled and selected
    if (includeShortcuts && selectedShortcut?.filter) {
      conditions.push(selectedShortcut.filter);
    }

    // Add active filters from context
    for (const filter of filters) {
      if (filter.factor === "contentSearch") {
        conditions.push(`content.contains(${escapeFilterValue(filter.value)})`);
      } else if (filter.factor === "tagSearch") {
        conditions.push(`tag in [${escapeFilterValue(filter.value)}]`);
      } else if (filter.factor === "pinned") {
        if (includePinned) {
          conditions.push(`pinned`);
        }
      } else if (filter.factor === "property.hasLink") {
        conditions.push(`has_link`);
      } else if (filter.factor === "property.hasTaskList") {
        conditions.push(`has_task_list`);
      } else if (filter.factor === "property.hasCode") {
        conditions.push(`has_code`);
      } else if (filter.factor === "displayTime") {
        const [year, month, day] = filter.value.split("-").map(Number);
        const startOfDay = new Date(year, month - 1, day).getTime() / 1000;
        const endOfDay = startOfDay + 60 * 60 * 24;

        conditions.push(`created_ts >= ${startOfDay} && created_ts < ${endOfDay}`);
      }
    }

    // Add visibility filter if specified
    if (visibilities && visibilities.length > 0) {
      const visibilityValues = visibilities.map((v) => `"${getVisibilityName(v)}"`).join(", ");
      conditions.push(`visibility in [${visibilityValues}]`);
    }

    return conditions.length > 0 ? conditions.join(" && ") : undefined;
  }, [creatorName, includeShortcuts, includePinned, visibilities, selectedShortcut, filters]);
};
