import type { AIProvider } from "@agestra/core";
import type { DocumentManager, Document } from "@agestra/workspace";

export class ReviewSession {
  private docManager: DocumentManager;

  constructor(docManager: DocumentManager) {
    this.docManager = docManager;
  }

  async startReview(files: string[], rules: string[]): Promise<Document> {
    return this.docManager.createReview({ files, rules });
  }

  async requestReview(docId: string, provider: AIProvider): Promise<string> {
    const doc = await this.docManager.read(docId);

    const prompt = `Please review the following code review document and provide your analysis.\n\n${doc.content}`;

    const response = await provider.chat({ prompt });

    await this.docManager.addComment(docId, {
      author: provider.id,
      content: response.text,
    });

    return response.text;
  }
}
