const { TOPIC_MAPPING, TOPIC_SYNONYMS, normalizeTopic } = require('../../shared/topic-context');

describe('Topic mapping', () => {
  test('known topics resolve to categories', () => {
    expect(TOPIC_MAPPING.dspy.tool_cats).toContain('ai');
    expect(TOPIC_MAPPING.docker.tool_cats).toContain('docker_management');
    expect(TOPIC_MAPPING.infra.kb_tags).toContain('infrastructure');
  });

  test('extended topics are defined', () => {
    expect(TOPIC_MAPPING.llm).toBeDefined();
    expect(TOPIC_MAPPING.supabase).toBeDefined();
    expect(TOPIC_MAPPING.monitoring).toBeDefined();
    expect(TOPIC_MAPPING.database).toBeDefined();
    expect(TOPIC_MAPPING.codex).toBeDefined();
    expect(TOPIC_MAPPING.ingestion).toBeDefined();
  });

  test('all topics have required fields', () => {
    for (const [key, val] of Object.entries(TOPIC_MAPPING)) {
      expect(val.tool_cats).toBeDefined();
      expect(Array.isArray(val.tool_cats)).toBe(true);
      expect(val.kb_tags).toBeDefined();
      expect(Array.isArray(val.kb_tags)).toBe(true);
      expect(val.kb_cats).toBeDefined();
    }
  });

  test('synonyms resolve to valid topics', () => {
    for (const [syn, target] of Object.entries(TOPIC_SYNONYMS)) {
      expect(TOPIC_MAPPING[target]).toBeDefined();
    }
  });

  test('normalizeTopic resolves known topics', () => {
    expect(normalizeTopic('docker')).toBe('docker');
    expect(normalizeTopic('dspy')).toBe('dspy');
    expect(normalizeTopic('supabase')).toBe('supabase');
  });

  test('normalizeTopic resolves synonyms', () => {
    expect(normalizeTopic('prometheus')).toBe('monitoring');
    expect(normalizeTopic('grafana')).toBe('monitoring');
    expect(normalizeTopic('postgres')).toBe('database');
    expect(normalizeTopic('qwen')).toBe('llm');
    expect(normalizeTopic('github')).toBe('codex');
    expect(normalizeTopic('truenas')).toBe('backup');
  });

  test('normalizeTopic handles compound strings', () => {
    expect(normalizeTopic('dspy optimization run')).toBe('dspy');
    expect(normalizeTopic('docker compose issue')).toBe('docker');
  });

  test('normalizeTopic returns key for unknown topics', () => {
    const result = normalizeTopic('random stuff');
    expect(result).toBe('random');
  });

  test('normalizeTopic handles empty/null', () => {
    expect(normalizeTopic('')).toBe('general');
    expect(normalizeTopic(null)).toBe('general');
    expect(normalizeTopic(undefined)).toBe('general');
  });
});
