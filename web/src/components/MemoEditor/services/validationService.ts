import type { EditorState } from "../state";
import type { Translations } from "@/utils/i18n";

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  reasonKey?: Translations;
  reasonParams?: Record<string, unknown>;
}

const getUtf8ByteLength = (value: string) => new TextEncoder().encode(value).length;

export const validationService = {
  canSave(state: EditorState, options?: { contentLengthLimit?: number }): ValidationResult {
    // Cannot save while loading initial content
    if (state.ui.isLoading.loading) {
      return { valid: false, reasonKey: "message.memo-loading-content" };
    }

    // Must have content, attachment, or local file
    if (!state.content.trim() && state.metadata.attachments.length === 0 && state.localFiles.length === 0) {
      return { valid: false, reasonKey: "message.memo-content-or-file-required" };
    }

    // Cannot save while uploading
    if (state.ui.isLoading.uploading) {
      return { valid: false, reasonKey: "message.memo-upload-in-progress" };
    }

    // Cannot save while audio recorder is active
    if (state.audioRecorder.status === "recording" || state.audioRecorder.status === "requesting_permission") {
      return { valid: false, reasonKey: "message.memo-recording-in-progress" };
    }

    // Cannot save while already saving
    if (state.ui.isLoading.saving) {
      return { valid: false, reasonKey: "message.memo-save-in-progress" };
    }

    const contentLengthLimit = options?.contentLengthLimit ?? 0;
    if (contentLengthLimit > 0 && getUtf8ByteLength(state.content) > contentLengthLimit) {
      return {
        valid: false,
        reasonKey: "message.memo-content-too-long",
        reasonParams: { size: contentLengthLimit },
      };
    }

    return { valid: true };
  },
};
