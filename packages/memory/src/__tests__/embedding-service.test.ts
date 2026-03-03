import { describe, it, expect, vi } from 'vitest';
import { EmbeddingService } from '../embedding-service.js';
import type { EmbeddingProvider } from '../types.js';

// ── Helper ──────────────────────────────────────────────────────────

function makeProvider(overrides?: Partial<EmbeddingProvider>): EmbeddingProvider {
  return {
    embed: overrides?.embed ?? vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    modelId: overrides?.modelId ?? 'test-model-v1',
    dimension: overrides?.dimension ?? 3,
  };
}

// ── cosineSimilarity ────────────────────────────────────────────────

describe('EmbeddingService.cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [1, 2, 3];
    expect(EmbeddingService.cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(EmbeddingService.cosineSimilarity(a, b)).toBeCloseTo(0.0, 10);
  });

  it('returns -1.0 for opposite vectors', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(EmbeddingService.cosineSimilarity(a, b)).toBeCloseTo(-1.0, 10);
  });

  it('computes correct value for known vectors', () => {
    // a = [1, 0], b = [1, 1]
    // dot = 1, |a| = 1, |b| = sqrt(2)
    // cos = 1 / sqrt(2) ~= 0.7071
    const a = [1, 0];
    const b = [1, 1];
    expect(EmbeddingService.cosineSimilarity(a, b)).toBeCloseTo(
      1 / Math.sqrt(2),
      10,
    );
  });

  it('returns 0 for empty vectors', () => {
    expect(EmbeddingService.cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(EmbeddingService.cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns 0 when a vector is all zeros', () => {
    expect(EmbeddingService.cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

// ── vectorToBlob / blobToVector ─────────────────────────────────────

describe('vectorToBlob and blobToVector', () => {
  it('roundtrips preserve values', () => {
    const original = [1.5, -2.7, 0, 3.14159, Number.MAX_SAFE_INTEGER];
    const blob = EmbeddingService.vectorToBlob(original);
    const restored = EmbeddingService.blobToVector(blob);
    expect(restored).toEqual(original);
  });

  it('handles empty array', () => {
    const blob = EmbeddingService.vectorToBlob([]);
    expect(blob.length).toBe(0);
    expect(EmbeddingService.blobToVector(blob)).toEqual([]);
  });

  it('produces correct buffer size', () => {
    const vec = [1, 2, 3, 4, 5];
    const blob = EmbeddingService.vectorToBlob(vec);
    // 5 doubles * 8 bytes each = 40
    expect(blob.length).toBe(40);
  });
});

// ── vectorToFloat32Blob / float32BlobToVector ───────────────────────

describe('vectorToFloat32Blob and float32BlobToVector', () => {
  it('roundtrips preserve values within float32 precision', () => {
    const original = [1.5, -2.5, 0, 3.0];
    const blob = EmbeddingService.vectorToFloat32Blob(original);
    const restored = EmbeddingService.float32BlobToVector(blob);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it('handles empty array', () => {
    const blob = EmbeddingService.vectorToFloat32Blob([]);
    expect(blob.length).toBe(0);
    expect(EmbeddingService.float32BlobToVector(blob)).toEqual([]);
  });

  it('produces correct buffer size (4 bytes per float)', () => {
    const vec = [1, 2, 3, 4, 5];
    const blob = EmbeddingService.vectorToFloat32Blob(vec);
    // 5 floats * 4 bytes each = 20
    expect(blob.length).toBe(20);
  });

  it('loses precision compared to float64', () => {
    // Pi has more precision in float64 than float32
    const original = [Math.PI];
    const blob = EmbeddingService.vectorToFloat32Blob(original);
    const restored = EmbeddingService.float32BlobToVector(blob);
    // float32 has ~7 decimal digits of precision
    expect(restored[0]).toBeCloseTo(Math.PI, 5);
    // but not exact
    expect(restored[0]).not.toBe(Math.PI);
  });
});

// ── rankBySimilarity ────────────────────────────────────────────────

describe('rankBySimilarity', () => {
  it('sorts candidates by similarity descending', () => {
    const service = new EmbeddingService();
    const queryVec = [1, 0, 0];

    // Candidate A: identical direction -> similarity ~1.0
    // Candidate B: orthogonal -> similarity ~0.0
    // Candidate C: partially aligned -> similarity ~0.707
    const candidates = [
      { id: 'b', embedding: EmbeddingService.vectorToBlob([0, 1, 0]) },
      { id: 'a', embedding: EmbeddingService.vectorToBlob([1, 0, 0]) },
      { id: 'c', embedding: EmbeddingService.vectorToBlob([1, 1, 0]) },
    ];

    const results = service.rankBySimilarity(queryVec, candidates);

    expect(results).toHaveLength(3);
    expect(results[0].id).toBe('a');
    expect(results[0].similarity).toBeCloseTo(1.0, 10);
    expect(results[1].id).toBe('c');
    expect(results[1].similarity).toBeCloseTo(1 / Math.sqrt(2), 10);
    expect(results[2].id).toBe('b');
    expect(results[2].similarity).toBeCloseTo(0.0, 10);
  });

  it('returns empty array for empty candidates', () => {
    const service = new EmbeddingService();
    const results = service.rankBySimilarity([1, 0], []);
    expect(results).toEqual([]);
  });
});

// ── embedText ───────────────────────────────────────────────────────

describe('embedText', () => {
  it('returns null when no provider is set', async () => {
    const service = new EmbeddingService();
    const result = await service.embedText('hello');
    expect(result).toBeNull();
  });

  it('delegates to provider when available', async () => {
    const expectedVec = [0.5, 0.6, 0.7];
    const embedFn = vi.fn().mockResolvedValue(expectedVec);
    const provider = makeProvider({ embed: embedFn });
    const service = new EmbeddingService(provider);

    const result = await service.embedText('test input');

    expect(embedFn).toHaveBeenCalledWith('test input');
    expect(result).toEqual(expectedVec);
  });

  it('returns null when provider returns null', async () => {
    const embedFn = vi.fn().mockResolvedValue(null);
    const provider = makeProvider({ embed: embedFn });
    const service = new EmbeddingService(provider);

    const result = await service.embedText('something');
    expect(result).toBeNull();
  });
});

// ── available / modelId ─────────────────────────────────────────────

describe('available', () => {
  it('returns false without provider', () => {
    const service = new EmbeddingService();
    expect(service.available).toBe(false);
  });

  it('returns true with provider', () => {
    const service = new EmbeddingService(makeProvider());
    expect(service.available).toBe(true);
  });
});

describe('modelId', () => {
  it('returns empty string without provider', () => {
    const service = new EmbeddingService();
    expect(service.modelId).toBe('');
  });

  it('returns provider modelId with provider', () => {
    const service = new EmbeddingService(makeProvider({ modelId: 'ada-002' }));
    expect(service.modelId).toBe('ada-002');
  });
});
