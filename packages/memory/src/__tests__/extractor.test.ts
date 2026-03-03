import { describe, expect, it } from 'vitest';

import { RegexExtractor } from '../extractor.js';

describe('RegexExtractor', () => {
  const extractor = new RegexExtractor();

  // -- Korean Decision Patterns --

  describe('Korean decision patterns', () => {
    it('matches ~(으)로 결정', () => {
      const items = extractor.extract('React로 결정했습니다.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('decision');
      expect(items[0].topic).toBe('decisions');
      expect(items[0].importance).toBe(0.7);
    });

    it('matches ~(으)로 가기로 했다', () => {
      const items = extractor.extract('TypeScript로 가기로 했다.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('decision');
      expect(items[0].content).toBe('TypeScript로 가기로 했다.');
    });

    it('matches ~를 쓰기로 했다', () => {
      const items = extractor.extract('Zustand를 쓰기로 했다.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('decision');
    });

    it('matches ~를 사용하기로', () => {
      const items = extractor.extract('SQLite를 사용하기로 합시다.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('decision');
    });

    it('matches ~하기로 합의', () => {
      const items = extractor.extract('FTS5를 도입하기로 합의했습니다.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('decision');
      expect(items[0].topic).toBe('decisions');
    });
  });

  // -- Korean Preference Patterns --

  describe('Korean preference patterns', () => {
    it('matches ~를 추천', () => {
      const items = extractor.extract('Vitest를 추천합니다.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('preference');
      expect(items[0].topic).toBe('preferences');
      expect(items[0].importance).toBe(0.5);
    });

    it('matches ~가 좋겠다', () => {
      const items = extractor.extract('이 방식이 가 좋겠다.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('preference');
    });

    it('matches ~를 선호', () => {
      const items = extractor.extract('함수형 프로그래밍을 선호합니다.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('preference');
    });

    it('matches ~가 낫다', () => {
      const items = extractor.extract('이 접근법이 가 낫다.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('preference');
    });
  });

  // -- Korean Fact Patterns --

  describe('Korean fact patterns', () => {
    it('matches ~는 ~이다', () => {
      const items = extractor.extract('Electron은 크로스플랫폼 프레임워크는 도구이다.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('fact');
      expect(items[0].topic).toBe('technical');
      expect(items[0].importance).toBe(0.5);
    });

    it('matches ~를 지원한다', () => {
      const items = extractor.extract('SQLite는 FTS5를 지원한다.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('fact');
    });

    it('matches ~가 필요하다', () => {
      const items = extractor.extract('타입 안전성이 가 필요하다.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('fact');
    });

    it('matches ~의 장점은', () => {
      const items = extractor.extract('React의 장점은 컴포넌트 재사용이다.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('fact');
    });
  });

  // -- English Decision Patterns --

  describe('English decision patterns', () => {
    it('matches "decided to"', () => {
      const items = extractor.extract('We decided to use TypeScript.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('decision');
      expect(items[0].topic).toBe('decisions');
      expect(items[0].importance).toBe(0.7);
    });

    it('matches "agreed on"', () => {
      const items = extractor.extract('The team agreed on the new architecture.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('decision');
    });

    it('matches "let\'s use"', () => {
      const items = extractor.extract("Let's use Zustand for state management.");
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('decision');
    });

    it('matches "settled on"', () => {
      const items = extractor.extract('We settled on SQLite for the database.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('decision');
    });
  });

  // -- English Preference Patterns --

  describe('English preference patterns', () => {
    it('matches "prefer"', () => {
      const items = extractor.extract('I prefer functional components.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('preference');
      expect(items[0].topic).toBe('preferences');
    });

    it('matches "recommend"', () => {
      const items = extractor.extract('I recommend using Vitest.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('preference');
    });
  });

  // -- English Fact Patterns --

  describe('English fact patterns', () => {
    it('matches "supports"', () => {
      const items = extractor.extract('SQLite supports full-text search.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('fact');
      expect(items[0].topic).toBe('technical');
    });

    it('matches "requires"', () => {
      const items = extractor.extract('This feature requires Node.js 18+.');
      expect(items).toHaveLength(1);
      expect(items[0].nodeType).toBe('fact');
    });
  });

  // -- Edge Cases --

  describe('edge cases', () => {
    it('returns empty array for empty text', () => {
      expect(extractor.extract('')).toEqual([]);
    });

    it('returns empty array for whitespace-only text', () => {
      expect(extractor.extract('   \n  ')).toEqual([]);
    });

    it('returns empty array when no patterns match', () => {
      const items = extractor.extract('안녕하세요. 오늘 날씨가 좋네요.');
      expect(items).toEqual([]);
    });
  });

  // -- extractFromMessages --

  describe('extractFromMessages', () => {
    it('extracts from multiple messages', () => {
      const result = extractor.extractFromMessages([
        { content: 'React로 결정했습니다.', providerId: 'a' },
        { content: 'Vitest를 추천합니다.', providerId: 'b' },
      ]);
      expect(result.items).toHaveLength(2);
      expect(result.turnCount).toBe(2);
      expect(result.items[0].nodeType).toBe('decision');
      expect(result.items[1].nodeType).toBe('preference');
    });

    it('returns turnCount matching input message count', () => {
      const result = extractor.extractFromMessages([
        { content: '안녕하세요.', providerId: 'a' },
        { content: '반갑습니다.', providerId: 'b' },
        { content: '좋습니다.', providerId: 'c' },
      ]);
      expect(result.turnCount).toBe(3);
      expect(result.items).toHaveLength(0);
    });
  });

  // -- Deduplication --

  describe('deduplication', () => {
    it('deduplicates identical sentences in one text', () => {
      const text = 'React로 결정했습니다.\nReact로 결정했습니다.';
      const items = extractor.extract(text);
      expect(items).toHaveLength(1);
    });

    it('deduplicates across multiple messages', () => {
      const result = extractor.extractFromMessages([
        { content: 'We decided to use React.', providerId: 'a' },
        { content: 'We decided to use React.', providerId: 'b' },
      ]);
      expect(result.items).toHaveLength(1);
    });
  });

  // -- Mapping Verification --

  describe('nodeType/topic/importance mapping', () => {
    it('maps decision patterns correctly', () => {
      const items = extractor.extract('We decided to adopt microservices.');
      expect(items[0]).toEqual({
        content: 'We decided to adopt microservices.',
        nodeType: 'decision',
        topic: 'decisions',
        importance: 0.7,
      });
    });

    it('maps preference patterns correctly', () => {
      const items = extractor.extract('I prefer TypeScript over JavaScript.');
      expect(items[0]).toEqual({
        content: 'I prefer TypeScript over JavaScript.',
        nodeType: 'preference',
        topic: 'preferences',
        importance: 0.5,
      });
    });

    it('maps fact patterns correctly', () => {
      const items = extractor.extract('The advantage of React is its ecosystem.');
      expect(items[0]).toEqual({
        content: 'The advantage of React is its ecosystem.',
        nodeType: 'fact',
        topic: 'technical',
        importance: 0.5,
      });
    });

    it('maps tech decision patterns correctly', () => {
      const items = extractor.extract('React 19 버전을 사용합니다.');
      expect(items[0]).toEqual({
        content: 'React 19 버전을 사용합니다.',
        nodeType: 'decision',
        topic: 'technical',
        importance: 0.6,
      });
    });
  });

  // -- Multi-sentence Extraction --

  describe('multi-sentence extraction', () => {
    it('extracts from multiple sentences in one text', () => {
      const text =
        'React로 결정했습니다. Vitest를 추천합니다. SQLite는 FTS5를 지원한다.';
      const items = extractor.extract(text);
      expect(items).toHaveLength(3);
      expect(items[0].nodeType).toBe('decision');
      expect(items[1].nodeType).toBe('preference');
      expect(items[2].nodeType).toBe('fact');
    });
  });
});
