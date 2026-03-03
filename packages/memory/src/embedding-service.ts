/**
 * Embedding service for Phase 3-b of the memory system.
 *
 * Wraps an optional EmbeddingProvider to provide vector operations:
 * text embedding, cosine similarity, serialization, and ranking.
 */

import type { EmbeddingProvider } from './types.js';

export class EmbeddingService {
  private readonly provider: EmbeddingProvider | null;

  constructor(provider?: EmbeddingProvider) {
    this.provider = provider ?? null;
  }

  /** Whether an embedding provider is available. */
  get available(): boolean {
    return this.provider !== null;
  }

  /** The provider's model identifier, or empty string if no provider. */
  get modelId(): string {
    return this.provider?.modelId ?? '';
  }

  /**
   * Embed text into a vector using the configured provider.
   * Returns null if no provider is set.
   */
  async embedText(text: string): Promise<number[] | null> {
    if (!this.provider) {
      return null;
    }
    return this.provider.embed(text);
  }

  /**
   * Compute cosine similarity between two vectors.
   * Returns 0 if either vector is empty or they have different lengths.
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0 || a.length !== b.length) {
      return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) {
      return 0;
    }

    return dot / denominator;
  }

  /**
   * Serialize a float64 array to a Buffer for SQLite BLOB storage.
   */
  static vectorToBlob(vec: number[]): Buffer {
    const buffer = Buffer.alloc(vec.length * 8);
    for (let i = 0; i < vec.length; i++) {
      buffer.writeDoubleLE(vec[i], i * 8);
    }
    return buffer;
  }

  /**
   * Deserialize a Buffer or Uint8Array (from SQLite BLOB) back to a float64 array.
   */
  static blobToVector(blob: Buffer | Uint8Array): number[] {
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    const count = buf.length / 8;
    const vec: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      vec[i] = buf.readDoubleLE(i * 8);
    }
    return vec;
  }

  /**
   * Serialize a float64 array to a float32 Buffer for sqlite-vec.
   *
   * sqlite-vec uses float32 internally. This is used when writing to
   * the knowledge_vec virtual table (ANN search).
   */
  static vectorToFloat32Blob(vec: number[]): Buffer {
    const buffer = Buffer.alloc(vec.length * 4);
    for (let i = 0; i < vec.length; i++) {
      buffer.writeFloatLE(vec[i], i * 4);
    }
    return buffer;
  }

  /**
   * Deserialize a float32 Buffer (from sqlite-vec) back to a float64 array.
   */
  static float32BlobToVector(blob: Buffer): number[] {
    const count = blob.length / 4;
    const vec: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      vec[i] = blob.readFloatLE(i * 4);
    }
    return vec;
  }

  /**
   * Rank candidates by cosine similarity to a query vector.
   * Returns results sorted by similarity in descending order.
   */
  rankBySimilarity(
    queryVec: number[],
    candidates: Array<{ id: string; embedding: Buffer | Uint8Array }>,
  ): Array<{ id: string; similarity: number }> {
    return candidates
      .map((candidate) => ({
        id: candidate.id,
        similarity: EmbeddingService.cosineSimilarity(
          queryVec,
          EmbeddingService.blobToVector(candidate.embedding),
        ),
      }))
      .sort((a, b) => b.similarity - a.similarity);
  }
}
