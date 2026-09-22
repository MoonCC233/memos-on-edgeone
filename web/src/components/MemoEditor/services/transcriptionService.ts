import { aiServiceClient } from "@/connect";

export const transcriptionService = {
  async transcribeFile(file: File, language?: string): Promise<string> {
    const content = new Uint8Array(await file.arrayBuffer());
    const response = await aiServiceClient.transcribe({
      audio: {
        source: {
          case: "content",
          value: content,
        },
        filename: file.name,
        contentType: file.type,
      },
      language,
    });

    return response.text;
  },
};
